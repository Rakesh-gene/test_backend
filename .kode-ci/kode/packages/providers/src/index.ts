import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findExecutable, command } from '@kode/execution';
import { redact } from '@kode/contracts';

export async function providerInventory() {
  return Promise.all(
    ['codex', 'claude', 'copilot'].map(async (name) => {
      const executable = findExecutable(name);
      if (!executable)
        return {
          provider: name,
          installed: false,
          authentication: 'unknown',
          live: 'not_run',
          reason: 'CLI not on PATH; SDK runtime discovery is checked separately by probes.',
        };
      const version = await command(executable, ['--version']);
      const auth = name === 'codex' ? await command(executable, ['login', 'status']) : undefined;
      return {
        provider: name,
        installed: true,
        version: version.stdout.trim(),
        authentication: auth
          ? auth.exitCode === 0
            ? 'authenticated'
            : 'not_authenticated'
          : 'unknown',
        live: 'not_run',
      };
    }),
  );
}

export class CodexConnection {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private buffer = '';
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  readonly notifications: { method: string; params: unknown }[] = [];
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  constructor(executable = findExecutable('codex')) {
    if (!executable) throw new Error('Codex CLI not installed.');
    this.child = spawn(executable, ['app-server'], { stdio: 'pipe', windowsHide: true });
    this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 4 * 1024 * 1024) {
        this.close();
        return;
      }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        let message: {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: unknown;
        };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.method && message.id !== undefined) {
          const handler = this.onRequest;
          void (
            handler
              ? handler(message.method, message.params)
              : Promise.resolve({ decision: 'decline' })
          )
            .then((result) =>
              this.child.stdin.write(JSON.stringify({ id: message.id, result }) + '\n'),
            )
            .catch(() =>
              this.child.stdin.write(
                JSON.stringify({
                  id: message.id,
                  error: { code: -32603, message: 'Host approval handler failed.' },
                }) + '\n',
              ),
            );
        } else if (message.method) {
          this.notifications.push({ method: message.method, params: redact(message.params) });
          if (this.notifications.length > 1000) this.notifications.shift();
        } else if (message.id !== undefined) {
          const p = this.pending.get(message.id);
          if (!p) continue;
          this.pending.delete(message.id);
          clearTimeout(p.timer);
          if (message.error) p.reject(new Error(JSON.stringify(redact(message.error))));
          else p.resolve(message.result);
        }
      }
    });
    const fail = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Codex connection closed.'));
      }
      this.pending.clear();
    };
    this.child.on('error', fail);
    this.child.on('close', fail);
  }
  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'kode_p00', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return result;
  }
  request(method: string, params: unknown = {}, timeout = 15000): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

export async function codexProbe(options: { live?: boolean; cwd: string }) {
  const connection = new CodexConnection();
  try {
    const initialization = await connection.initialize();
    const models = await connection.request('model/list', { limit: 10 });
    const account = await connection.request('account/read', { refreshToken: false });
    if (!options.live)
      return { initialization, models, account: redact(account), inference: 'not_run' };
    const start = (await connection.request('thread/start', {
      cwd: options.cwd,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      ephemeral: true,
    })) as { thread: { id: string } };
    await connection.request('turn/start', {
      threadId: start.thread.id,
      input: [
        {
          type: 'text',
          text: 'Reply exactly KODE_P00_READY. Do not invoke tools, edit files, or access network.',
        },
      ],
    });
    const deadline = Date.now() + 45000;
    while (
      Date.now() < deadline &&
      !connection.notifications.some((e) => e.method === 'turn/completed')
    )
      await new Promise((r) => setTimeout(r, 100));
    const completed = connection.notifications.find((e) => e.method === 'turn/completed');
    if (!completed) {
      await connection.request('thread/unsubscribe', { threadId: start.thread.id }).catch(() => {});
      throw new Error('Live Codex probe did not complete within 45 seconds.');
    }
    const turn = (
      completed.params as { turn: { status: string; items: { type: string; text?: string }[] } }
    ).turn;
    if (
      turn.status !== 'completed' ||
      !turn.items.some((item) => item.text?.includes('KODE_P00_READY'))
    )
      throw new Error('Codex did not return the required completion marker.');
    return {
      initialization,
      models,
      inference: completed,
      notificationMethods: connection.notifications.map((e) => e.method),
      id: randomUUID(),
    };
  } finally {
    connection.close();
  }
}

export async function codexPermissionProbe(cwd: string, decision: 'accept' | 'decline') {
  const connection = new CodexConnection();
  const requests: { method: string; decision: string }[] = [];
  connection.onRequest = async (method) => {
    requests.push({ method, decision });
    if (method.includes('permissions')) return { permissions: {}, scope: 'turn' };
    return { decision };
  };
  try {
    await connection.initialize();
    const start = (await connection.request('thread/start', {
      cwd,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      ephemeral: true,
    })) as { thread: { id: string } };
    await connection.request('turn/start', {
      threadId: start.thread.id,
      input: [
        {
          type: 'text',
          text: 'This is a disposable permission probe. Use the shell tool once to execute node -e "process.stdout.write(\'KODE_P00_PERMISSION\')". Do not edit files or access the network. If permission is denied, do not retry or use alternate tools: finish saying DENIED. Otherwise finish saying DONE.',
        },
      ],
    });
    const deadline = Date.now() + 60000;
    while (
      Date.now() < deadline &&
      !connection.notifications.some((n) => n.method === 'turn/completed')
    )
      await new Promise((r) => setTimeout(r, 100));
    if (!connection.notifications.some((n) => n.method === 'turn/completed'))
      throw new Error('Native permission probe timed out.');
    if (!requests.length)
      throw new Error(
        'No native approval request occurred; probe cannot establish permission routing.',
      );
    const commands = connection.notifications
      .filter((n) => n.method === 'item/completed')
      .map(
        (n) =>
          (
            n.params as {
              item?: {
                type?: string;
                status?: string;
                aggregatedOutput?: string;
                exitCode?: number;
              };
            }
          ).item,
      )
      .filter((item) => item?.type === 'commandExecution');
    const executed = commands.some(
      (item) => item?.exitCode === 0 && item.aggregatedOutput?.includes('KODE_P00_PERMISSION'),
    );
    if (decision === 'accept' && !executed)
      throw new Error(
        'Approval was returned, but the marker command did not execute successfully.',
      );
    if (decision === 'decline' && executed)
      throw new Error('Denied marker command executed unexpectedly.');
    return {
      decision,
      requests,
      commands,
      completed: connection.notifications.find((n) => n.method === 'turn/completed'),
      mode: 'controlled probe policy; not the P08 terminal broker',
    };
  } finally {
    connection.close();
  }
}
