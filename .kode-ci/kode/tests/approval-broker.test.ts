import { test, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '@kode/storage';
import { telemetry } from '@kode/observability';
import { ApprovalBroker } from '../apps/runner/src/approvals.js';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kode-approval-'));
  const store = new Store(join(root, 'state.sqlite'));
  await store.ready;
  const otel = telemetry({ quietLogs: true });
  const broker = new ApprovalBroker(store, otel);
  const input = {
    taskId: randomUUID(),
    provider: 'codex' as const,
    epoch: randomUUID(),
    nativeId: '1',
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'item',
    kind: 'command' as const,
    command: 'identical command',
    cwd: root,
    reason: 'fixture',
    details: '{}',
    choices: ['accept', 'decline', 'cancel'] as ('accept' | 'decline' | 'cancel')[],
    deadline: Date.now() + 10000,
  };
  const close = async () => {
    await broker.invalidate(input.epoch, 'cancelled').catch(() => {});
    await store.close();
    await otel.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  };
  const pending = async (count = 1) => {
    for (let i = 0; i < 100; i++) {
      const list = await broker.list();
      if (list.filter((x) => x.state === 'pending').length === count)
        return list.filter((x) => x.state === 'pending');
      await pause(5);
    }
    throw new Error('No pending requests');
  };
  return { store, broker, otel, input, close, pending };
}
test('native decisions use durable CAS, preserve invocation identity and distinguish acknowledgement from failed execution', async () => {
  const f = await fixture();
  try {
    const first = f.broker.request(f.input, (choice) => ({ decision: choice }));
    const duplicate = f.broker.request({ ...f.input, deadline: Date.now() + 11000 }, (choice) => ({
      decision: choice,
    }));
    const second = f.broker.request({ ...f.input, nativeId: '2', itemId: 'item2' }, (choice) => ({
      decision: choice,
    }));
    const list = await f.pending(2),
      one = list.find((x) => x.nativeId === '1')!,
      two = list.find((x) => x.nativeId === '2')!;
    await expect(f.broker.decide(one.id, one.version, '0'.repeat(64), 'accept')).rejects.toThrow(
      'changed',
    );
    const attempts = await Promise.allSettled([
      f.broker.decide(one.id, one.version, one.fingerprint, 'accept'),
      f.broker.decide(one.id, one.version, one.fingerprint, 'decline'),
    ]);
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await first).toEqual({ decision: 'accept' });
    expect(await duplicate).toEqual({ decision: 'accept' });
    expect((await f.broker.list()).find((x) => x.id === one.id)).toMatchObject({
      state: 'delivering',
    });
    expect((await f.broker.list()).find((x) => x.id === one.id)?.outcome).toBeUndefined();
    expect((await f.broker.list()).find((x) => x.id === two.id)?.state).toBe('pending');
    await f.broker.resolved(f.input.epoch, '1');
    await f.broker.outcome(f.input.epoch, 'item', 'failed');
    expect((await f.broker.list()).find((x) => x.id === one.id)).toMatchObject({
      state: 'resolved',
      decision: 'accept',
      outcome: 'failed',
    });
    await f.broker.decide(two.id, two.version, two.fingerprint, 'decline');
    expect(await second).toEqual({ decision: 'decline' });
  } finally {
    await f.close();
  }
});
test('native timeout and disconnect cannot grant permission, and restart never reconstructs callbacks', async () => {
  const f = await fixture();
  try {
    const timed = f.broker.request({ ...f.input, deadline: Date.now() + 50 }, (choice) => ({
      decision: choice,
    }));
    expect(await timed).toEqual({ decision: 'cancel' });
    expect((await f.broker.list())[0]?.state).toBe('expired');
    const pending = f.broker.request({ ...f.input, nativeId: '2' }, (choice) => ({
      decision: choice,
    }));
    const [record] = await f.pending();
    const restarted = new ApprovalBroker(f.store, f.otel);
    await restarted.recover();
    expect((await restarted.list()).find((x) => x.id === record!.id)?.state).toBe('superseded');
    await expect(
      restarted.decide(record!.id, record!.version, record!.fingerprint, 'accept'),
    ).rejects.toThrow('no longer attached');
    await f.broker.invalidate(f.input.epoch, 'delivery_unknown').catch(() => {});
    expect(await pending).toEqual({ decision: 'cancel' });
    const waiter = f.broker.request({ ...f.input, nativeId: '3' }, (choice) => ({
      decision: choice,
    }));
    const [sending] = await f.pending();
    await f.broker.decide(sending!.id, sending!.version, sending!.fingerprint, 'accept');
    await waiter;
    await restarted.recover();
    expect((await restarted.list()).find((x) => x.id === sending!.id)?.state).toBe(
      'delivery_unknown',
    );
  } finally {
    await f.close();
  }
});
