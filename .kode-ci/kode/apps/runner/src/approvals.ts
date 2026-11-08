import { createHash, randomUUID } from 'node:crypto';
import { NativeApproval, type NativeApprovalRecord } from '@kode/contracts';
import { captureTraceContext, withTraceContext, type telemetry } from '@kode/observability';
import type { Store } from '@kode/storage';

type Live = {
  record: NativeApprovalRecord;
  resolve: (reply: unknown) => void;
  reply: (choice: string, answers?: unknown) => unknown;
  timer: NodeJS.Timeout;
};
export class ApprovalBroker {
  private live = new Map<string, Live>();
  private identities = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private opening = new Map<string, Set<Promise<unknown>>>();
  private mutations = new Map<string, Promise<unknown>>();
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    this.mutations.set(id, result);
    try {
      return await result;
    } finally {
      if (this.mutations.get(id) === result) this.mutations.delete(id);
    }
  }
  constructor(
    private store: Store,
    private otel: Pick<ReturnType<typeof telemetry>, 'operation'>,
  ) {}
  async list() {
    return (await this.store.call('native.list')) as NativeApprovalRecord[];
  }
  private async transition(record: NativeApprovalRecord, patch: Partial<NativeApprovalRecord>) {
    return NativeApproval.parse(
      await this.store.call('native.transition', {
        expectedVersion: record.version,
        record: { ...record, ...patch, version: record.version + 1 },
      }),
    );
  }
  async recover() {
    for (const record of (await this.store.call('native.list', {
      unfinished: true,
    })) as NativeApprovalRecord[]) {
      await withTraceContext(record.traceContext, () =>
        this.otel.operation('approval.recover', () =>
          this.transition(record, {
            state: record.state === 'pending' ? 'superseded' : 'delivery_unknown',
            delivery:
              'Runner restarted; live request cannot be rebound. A fresh native request is required.',
          }),
        ),
      );
    }
  }
  async request(
    input: Omit<
      NativeApprovalRecord,
      'id' | 'fingerprint' | 'version' | 'state' | 'fixture' | 'traceContext'
    >,
    reply: Live['reply'],
  ) {
    const operation = { ...input, deadline: undefined };
    const fingerprint = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
    const key = `${input.epoch}:${input.nativeId}`;
    const duplicate = this.identities.get(key);
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint)
        throw new Error('Native request identity changed its operation.');
      return duplicate.promise;
    }
    if (this.live.size >= 128)
      throw new Error('Approval capacity reached; interrupt this invocation.');
    const record = NativeApproval.parse({
      ...input,
      id: randomUUID(),
      fingerprint,
      version: 1,
      state: 'pending',
      fixture: false,
      traceContext: captureTraceContext(),
    });
    const promise = this.otel.operation('approval.wait', async () => {
      record.traceContext = captureTraceContext();
      const opening = this.store.call('native.open', { record });
      const pending = this.opening.get(input.epoch) ?? new Set<Promise<unknown>>();
      this.opening.set(input.epoch, pending);
      pending.add(opening);
      try {
        await opening;
      } finally {
        pending.delete(opening);
        if (!pending.size) this.opening.delete(input.epoch);
      }
      return new Promise<unknown>((resolve) => {
        const timer = setTimeout(
          () => {
            void this.invalidate(record.epoch, 'expired', record.id).catch(() => {});
          },
          Math.max(1, record.deadline - Date.now()),
        );
        timer.unref();
        this.live.set(record.id, { record, resolve, reply, timer });
      });
    });
    this.identities.set(key, { fingerprint, promise });
    return promise;
  }
  async decide(
    id: string,
    version: number,
    fingerprint: string,
    choice: string,
    answers?: unknown,
  ) {
    return this.exclusive(id, () => this.decideAttached(id, version, fingerprint, choice, answers));
  }
  private async decideAttached(
    id: string,
    version: number,
    fingerprint: string,
    choice: string,
    answers?: unknown,
  ) {
    const live = this.live.get(id);
    if (!live || live.record.state !== 'pending' || live.record.deadline <= Date.now())
      throw new Error('Request is expired, obsolete or no longer attached.');
    if (live.record.version !== version || live.record.fingerprint !== fingerprint)
      throw new Error('Approval display changed; inspect its current version.');
    if (!live.record.choices.includes(choice as NativeApprovalRecord['choices'][number]))
      throw new Error('Choice is not supported by this native request.');
    const response = live.reply(choice, answers); // Validate before recording or sending.
    return withTraceContext(live.record.traceContext, () =>
      this.otel.operation('approval.decide', async (span) => {
        span.setAttribute('kode.approval.id', id);
        let record = await this.transition(live.record, {
          state: 'decision_recorded',
          decision: choice,
        });
        live.record = record;
        record = await this.transition(record, {
          state: 'delivering',
          delivery: 'Decision persisted; native acknowledgement pending.',
        });
        live.record = record;
        clearTimeout(live.timer);
        live.resolve(response);
        return record;
      }),
    );
  }
  async resolved(epoch: string, nativeId: string) {
    const live = [...this.live.values()].find(
      (item) => item.record.epoch === epoch && item.record.nativeId === nativeId,
    );
    if (!live) return;
    return this.exclusive(live.record.id, async () => {
      if (!this.live.has(live.record.id)) return;
      if (live.record.state === 'delivering')
        live.record = await this.transition(live.record, {
          state: 'resolved',
          delivery: 'Native protocol acknowledged request resolution; action outcome is separate.',
        });
      else if (live.record.state === 'pending') {
        live.record = await this.transition(live.record, {
          state: 'superseded',
          delivery: 'Native runtime cleared this request before a decision.',
        });
        live.resolve(live.reply('cancel'));
      }
      clearTimeout(live.timer);
      this.live.delete(live.record.id);
    });
  }
  async outcome(epoch: string, itemId: string, outcome: string) {
    const records = (await this.list()).filter(
      (record) => record.epoch === epoch && record.itemId === itemId,
    );
    for (const record of records) {
      // Older runtimes may report item completion instead of a resolution notification.
      if (record.state === 'delivering') await this.resolved(epoch, record.nativeId);
      const latest = (await this.list()).find((item) => item.id === record.id)!;
      if (latest.state === 'resolved') await this.transition(latest, { outcome });
    }
  }
  async invalidate(
    epoch: string,
    reason: 'cancelled' | 'expired' | 'delivery_unknown',
    id?: string,
  ) {
    await Promise.allSettled([...(this.opening.get(epoch) ?? [])]);
    for (const live of [...this.live.values()].filter(
      (item) => item.record.epoch === epoch && (!id || item.record.id === id),
    )) {
      await this.exclusive(live.record.id, async () => {
        if (!this.live.has(live.record.id)) return;
        const state =
          live.record.state === 'pending'
            ? reason === 'delivery_unknown'
              ? 'cancelled'
              : reason
            : 'delivery_unknown';
        try {
          live.record = await this.transition(live.record, {
            state,
            delivery: 'Request unavailable; no grant can be reused.',
          });
        } finally {
          clearTimeout(live.timer);
          live.resolve(live.reply('cancel'));
          this.live.delete(live.record.id);
        }
      });
    }
    if (!id)
      for (const key of this.identities.keys())
        if (key.startsWith(epoch + ':')) this.identities.delete(key);
  }
}
