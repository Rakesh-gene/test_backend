import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import Database from 'better-sqlite3';
import { emptyView, projectEvent, redact, safeTerminal, MAX_FRAME_BYTES } from '@kode/contracts';
import { Store, putArtifact } from '@kode/storage';
import { startRunner, RunnerClient } from '@kode/runner';
import { grammarProbe } from '@kode/context';
import { telemetry } from '@kode/observability';

async function temporary() {
  return mkdtemp(join(tmpdir(), 'kode-test-'));
}
const input = () => ({
  id: randomUUID(),
  kind: 'task.updated',
  taskId: 'task-a',
  data: { title: 'Implement fixture', agent: 'backend', status: 'ready', provider: 'fixture' },
});

describe('durable storage and migrations', () => {
  it('persists, replays, deduplicates IDs and rejects conflicting event reuse', async () => {
    const path = join(await temporary(), 'state.sqlite');
    const store = new Store(path);
    const event = input();
    try {
      const first = await store.append(event);
      expect((await store.append(event)).seq).toBe(first.seq);
      await expect(store.append({ ...event, data: { changed: true } })).rejects.toThrow(
        'different content',
      );
      const view = emptyView();
      projectEvent(view, first);
      projectEvent(view, first);
      expect(view.tasks.size).toBe(1);
      expect(view.events).toHaveLength(1);
    } finally {
      await store.close();
    }
    const reopened = new Store(path);
    try {
      expect(await reopened.list()).toHaveLength(1);
      expect((await reopened.list())[0]!.taskId).toBe('task-a');
    } finally {
      await reopened.close();
    }
  });
  it('rolls back failed migrations and can open the same database afterward', async () => {
    const path = join(await temporary(), 'state.sqlite');
    const broken = new Store(path, { failMigration: true });
    await expect(broken.ready).rejects.toThrow('rolled back');
    await broken.terminate();
    const direct = new Database(path);
    expect(direct.pragma('user_version', { simple: true })).toBe(0);
    expect(direct.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toHaveLength(
      0,
    );
    direct.close();
    const recovered = new Store(path);
    try {
      await recovered.append(input());
      expect(await recovered.list()).toHaveLength(1);
    } finally {
      await recovered.close();
    }
  });
  it('refuses future versions and corrupt databases with a useful error', async () => {
    const root = await temporary();
    const path = join(root, 'future.sqlite');
    const direct = new Database(path);
    direct.pragma('user_version = 99');
    direct.close();
    const future = new Store(path);
    await expect(future.ready).rejects.toThrow('Unsupported database schema 99');
    await future.terminate();
    const corrupt = join(root, 'bad.sqlite');
    await writeFile(corrupt, 'not a database');
    const broken = new Store(corrupt);
    await expect(broken.ready).rejects.toThrow(/database/);
    await broken.terminate();
  });
  it('writes immutable content-addressed artifacts and detects corruption', async () => {
    const root = await temporary();
    const bytes = Buffer.from('proof fixture');
    const first = await putArtifact(root, bytes);
    expect(await putArtifact(root, bytes)).toEqual(first);
    await writeFile(first.path, 'corrupt');
    await expect(putArtifact(root, bytes)).rejects.toThrow('corrupted');
  });
});

describe('workspace runner transport', () => {
  it('logs startup schema failures and releases ownership for recovery', async () => {
    const root = await temporary();
    await mkdir(join(root, '.kode'));
    const path = join(root, '.kode/state.sqlite');
    const db = new Database(path);
    db.pragma('user_version = 99');
    db.close();
    await expect(startRunner(root)).rejects.toThrow('Unsupported database schema');
    await expect(access(join(root, '.kode/runner.lock'))).rejects.toThrow();
    expect(await readFile(join(root, '.kode/runner.log'), 'utf8')).toContain(
      'Unsupported database schema',
    );
  });
  it('supports two clients, enforces the owner lease and rejects unauthorized access', async () => {
    const root = await temporary();
    const runner = await startRunner(root);
    const a = await RunnerClient.connect(runner.paths),
      b = await RunnerClient.connect(runner.paths);
    const unauthorized = await RunnerClient.connect(runner.paths, 'x'.repeat(64));
    try {
      expect(await a.request('ping')).toMatchObject({ pong: true });
      expect(await b.request('ping')).toMatchObject({ pong: true });
      await expect(startRunner(root)).rejects.toThrow('already owns');
      await expect(unauthorized.request('shutdown')).rejects.toThrow('UNAUTHORIZED');
      expect(await a.request('ping')).toMatchObject({ pong: true });
      await expect(a.request('fixture.load')).rejects.toThrow('Fixture mode');
    } finally {
      a.close();
      b.close();
      unauthorized.close();
      await runner.close();
    }
  });
  it('records fixture decisions once and replays persisted state after restart', async () => {
    const root = await temporary();
    let runner = await startRunner(root, { testing: true });
    let client = await RunnerClient.connect(runner.paths);
    await Promise.all([client.request('fixture.load'), client.request('fixture.load')]);
    const before = (await client.request('events.list')) as {
      seq: number;
      kind: string;
      data: { id: string };
    }[];
    const approval = before.find((e) => e.kind === 'approval.requested')!;
    expect(before.filter((e) => e.kind === 'approval.requested')).toHaveLength(1);
    expect(
      await client.request('approval.respond', {
        requestId: approval.data.id,
        decision: 'deny',
        expectedVersion: 1,
      }),
    ).toMatchObject({ fixture: true, delivered: false });
    await expect(
      client.request('approval.respond', {
        requestId: approval.data.id,
        decision: 'approve',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('already resolved');
    client.close();
    await runner.close();
    runner = await startRunner(root, { testing: true });
    client = await RunnerClient.connect(runner.paths);
    try {
      const events = (await client.request('events.list')) as { seq: number; kind: string }[];
      expect(events.filter((e) => e.kind === 'approval.resolved')).toHaveLength(1);
      expect(
        (await client.request('events.list', { after: before.at(-1)!.seq })) as unknown[],
      ).toHaveLength(2);
    } finally {
      client.close();
      await runner.close();
    }
  });
  it('keeps ping responsive while the SQLite worker executes a costly query', async () => {
    const runner = await startRunner(await temporary(), { testing: true });
    const client = await RunnerClient.connect(runner.paths);
    try {
      let finished = false;
      const slow = client.request('test.slowQuery').then(() => {
        finished = true;
      });
      expect(await client.request('ping')).toMatchObject({ pong: true });
      expect(finished).toBe(false);
      await slow;
    } finally {
      client.close();
      await runner.close();
    }
  });
  it('rejects invalid versions and oversized frames without killing the runner', async () => {
    const runner = await startRunner(await temporary());
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(runner.paths.endpoint);
        socket.on('error', reject);
        socket.on('data', (bytes) => {
          socket.destroy();
          resolve(bytes.toString());
        });
        socket.on('connect', () =>
          socket.write(
            JSON.stringify({ version: 99, token: runner.token, id: 'old', method: 'ping' }) + '\n',
          ),
        );
      });
      expect(response).toContain('INVALID_REQUEST');
      await new Promise<void>((resolve, reject) => {
        const socket = connect(runner.paths.endpoint);
        socket.on('error', () => {});
        socket.on('close', () => resolve());
        socket.on('connect', () => socket.write('x'.repeat(MAX_FRAME_BYTES + 1)));
        setTimeout(() => {
          socket.destroy();
          reject(new Error('Oversize connection was not closed.'));
        }, 2000).unref();
      });
      const client = await RunnerClient.connect(runner.paths);
      expect(await client.request('ping')).toMatchObject({ pong: true });
      client.close();
    } finally {
      await runner.close();
    }
  });
  it('recovers a dead process lease, but not a live owner', async () => {
    const root = await temporary();
    await mkdir(join(root, '.kode'));
    await writeFile(
      join(root, '.kode/runner.lock'),
      JSON.stringify({ pid: 2147483647, owner: randomUUID() }),
    );
    const runner = await startRunner(root);
    await runner.close();
  });
});

describe('context, redaction and OpenTelemetry', () => {
  it('parses a real JavaScript fixture through a WASM grammar', async () => {
    expect(await grammarProbe()).toMatchObject({ declarations: [{ name: 'greet', line: 1 }] });
  });
  it('redacts credentials before event persistence and sanitizes terminal controls', async () => {
    const secret = 'fixture-super-secret-123';
    expect(redact({ password: 'hidden', nested: { message: secret } }, [secret])).toEqual({
      password: '[REDACTED]',
      nested: { message: '[REDACTED]' },
    });
    expect(safeTerminal('safe\x1b[2J\x1b]0;owned\x07text')).toBe('safetext');
    expect(redact({ ConnectionStrings__DefaultConnection: secret })).toEqual({
      ConnectionStrings__DefaultConnection: '[REDACTED]',
    });
    const path = join(await temporary(), 'state.sqlite');
    const store = new Store(path);
    try {
      await store.append({ ...input(), data: { token: secret, message: `contains ${secret}` } }, [
        secret,
      ]);
      expect(JSON.stringify(await store.list())).not.toContain(secret);
    } finally {
      await store.close();
    }
  });
  it('exports correlated traces/logs/metrics and redacts before log and export sinks', async () => {
    const root = await temporary();
    const received: { path: string; body: string }[] = [];
    const server = httpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ path: request.url!, body: Buffer.concat(chunks).toString() });
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address() as { port: number };
    const secret = 'fixture-telemetry-secret-123';
    const logFile = join(root, 'output.log');
    const otel = telemetry({
      endpoint: `http://127.0.0.1:${address.port}`,
      logFile,
      secrets: [secret],
    });
    try {
      await otel.operation('fixture.operation', async (span) => {
        otel.log(`message ${secret}`, { password: secret }, span);
      });
      await otel.flush();
      expect(received.map((x) => x.path)).toEqual(
        expect.arrayContaining(['/v1/traces', '/v1/logs', '/v1/metrics']),
      );
      const logs = await readFile(logFile, 'utf8');
      const parsed = JSON.parse(logs.split('\n')[0]!);
      expect(parsed.trace_id).toMatch(/^[a-f0-9]{32}$/);
      expect(parsed.span_id).toMatch(/^[a-f0-9]{16}$/);
      expect(logs).not.toContain(secret);
      expect(JSON.stringify(received)).not.toContain(secret);
      expect(received.find((x) => x.path === '/v1/traces')!.body).toContain(parsed.trace_id);
    } finally {
      await otel.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it('survives an unavailable collector while durable state still works', async () => {
    const portServer = createServer();
    await new Promise<void>((r) => portServer.listen(0, '127.0.0.1', r));
    const { port } = portServer.address() as { port: number };
    await new Promise<void>((r) => portServer.close(() => r()));
    const root = await temporary();
    const otel = telemetry({ endpoint: `http://127.0.0.1:${port}`, logFile: join(root, 'log') });
    const store = new Store(join(root, 'state.sqlite'));
    try {
      await otel.operation('collector.offline', async () => {
        await store.append(input());
      });
      await otel.flush();
      expect(await store.list()).toHaveLength(1);
    } finally {
      await store.close();
      await otel.close();
    }
  });
});
