import { createServer, connect, type Socket, type Server } from 'node:net';
import { readFile, writeFile, open, unlink, chmod } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RpcRequest,
  RpcResponse,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  ReplayParams,
  DecisionParams,
  redact,
  type Request,
  type Response,
} from '@kode/contracts';
import { Store } from '@kode/storage';
import {
  telemetry,
  captureTraceContext,
  traceCorrelation,
  withTraceContext,
  SpanKind,
} from '@kode/observability';
import { workspacePaths, protectStateDirectory, type Paths } from './paths.js';
import { workspaceMethods } from './workspace.js';
export { workspacePaths } from './paths.js';

export async function startRunner(root: string, options: { testing?: boolean } = {}) {
  const paths = await workspacePaths(root);
  const owner = randomUUID();
  try {
    const lock = await open(paths.lease, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, owner }));
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const lease = JSON.parse(await readFile(paths.lease, 'utf8')) as { pid: number };
    let alive = true;
    try {
      process.kill(lease.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive)
      throw new Error('A runner already owns this workspace. Attach instead of starting another.', {
        cause: error,
      });
    // Serialize stale recovery separately; a live runner's lease is never removed.
    const recovery = await open(`${paths.lease}.recovery`, 'wx', 0o600);
    try {
      await unlink(paths.lease);
      if (process.platform !== 'win32') await unlink(paths.endpoint).catch(() => {});
    } finally {
      await recovery.close();
      await unlink(`${paths.lease}.recovery`);
    }
    return startRunner(root, options);
  }
  const token = randomBytes(32).toString('hex');
  let store: Store | undefined;
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  let closing = false;
  let observability: ReturnType<typeof telemetry> | undefined;
  let projects: ReturnType<typeof workspaceMethods> | undefined;
  async function cleanup() {
    if (closing) return;
    closing = true;
    await projects?.stop();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (store) await store.close().catch(() => store!.terminate());
    await observability?.close();
    const lease = await readFile(paths.lease, 'utf8')
      .then((s) => JSON.parse(s) as { owner: string })
      .catch(() => undefined);
    if (lease?.owner === owner) {
      await unlink(paths.lease).catch(() => {});
      await unlink(paths.token).catch(() => {});
    }
  }
  try {
    await protectStateDirectory(paths.state);
    await writeFile(paths.token, token, { mode: 0o600 });
    observability = telemetry({ logFile: paths.log, secrets: [token] });
    store = new Store(paths.database);
    await store.ready;
    projects = workspaceMethods(
      paths.root,
      async (activity) => {
        await store!.append({
          id: randomUUID(),
          kind: 'tool.updated',
          data: { ...activity, ...traceCorrelation() },
        });
        observability!.log('workspace.activity', activity);
      },
      observability,
    );
    await store.append({
      id: randomUUID(),
      kind: 'runner.started',
      data: { protocol: 1, pid: process.pid },
    });
    await projects.recover();
    async function handle(request: Request): Promise<unknown> {
      switch (request.method) {
        case 'ping':
          return { pong: true, pid: process.pid, protocol: 1, capabilities: ['w3c-trace-context'] };
        case 'status':
          return {
            ...((await store!.call('count')) as object),
            pid: process.pid,
            root: paths.root,
            phase: 'P03 workspace and execution',
            workspace: await projects!.workspace.list(),
            providers: 'not connected',
            fixtureMode: options.testing ?? false,
            telemetry: await observability!.status(),
          };
        case 'events.list': {
          const p = ReplayParams.parse(request.params);
          return store!.list(p.after, p.limit);
        }
        case 'fixture.load': {
          if (!options.testing)
            throw new Error('Fixture mode is not enabled. Restart with --fixture.');
          await loadFixture(store!);
          return { fixture: true };
        }
        case 'approval.respond': {
          if (!options.testing)
            throw new Error('No native approval adapters are connected in P01.');
          const p = DecisionParams.parse(request.params);
          return store!.decision(p.requestId, p.decision, p.expectedVersion);
        }
        case 'test.slowQuery':
          if (options.testing) return store!.call('slow');
          else throw new Error('Test method disabled.');
        case 'shutdown':
          setTimeout(() => {
            void cleanup();
          }, 50);
          return { stopping: true };
        default:
          return projects!.handle(request);
      }
    }
    server = createServer((socket) => {
      sockets.add(socket);
      let buffer = Buffer.alloc(0);
      let inFlight = 0;
      socket.setTimeout(30000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      const send = (response: Omit<Response, 'jsonrpc'>) => {
        if (!socket.destroyed) {
          const text = JSON.stringify({ jsonrpc: '2.0', ...response }) + '\n';
          if (
            Buffer.byteLength(text) > MAX_FRAME_BYTES ||
            socket.writableLength > MAX_FRAME_BYTES * 4
          )
            socket.destroy();
          else socket.write(text);
        }
      };
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let newline: number;
        while ((newline = buffer.indexOf(10)) !== -1) {
          const frame = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          if (frame.length > MAX_FRAME_BYTES) {
            socket.destroy();
            return;
          }
          let request: Request;
          try {
            request = RpcRequest.parse(JSON.parse(frame.toString('utf8')));
            const supplied = Buffer.from(request.token);
            if (
              supplied.length !== token.length ||
              !timingSafeEqual(supplied, Buffer.from(token))
            ) {
              send({
                version: 1,
                id: request.id,
                error: {
                  code: -32001,
                  message: 'Invalid workspace credential.',
                  data: { code: 'UNAUTHORIZED' },
                },
              });
              continue;
            }
          } catch {
            send({
              version: 1,
              id: null,
              error: {
                code: -32600,
                message: 'Invalid or unsupported RPC request.',
                data: { code: 'INVALID_REQUEST' },
              },
            });
            continue;
          }
          if (++inFlight > 8) {
            socket.destroy();
            return;
          }
          void withTraceContext(request.traceContext, () =>
            observability!.operation(`rpc.${request.method}`, () => handle(request), {
              kind: SpanKind.SERVER,
            }),
          )
            .then((result) => send({ version: 1, id: request.id, result }))
            .catch((error) =>
              send({
                version: 1,
                id: request.id,
                error: {
                  code: -32000,
                  message: String(redact(String(error), [token])),
                  data: { code: 'REQUEST_FAILED' },
                },
              }),
            )
            .finally(() => inFlight--);
        }
        if (buffer.length > MAX_FRAME_BYTES) socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(paths.endpoint, resolve);
    });
    if (process.platform !== 'win32') await chmod(paths.endpoint, 0o600);
    return { paths, token, close: cleanup };
  } catch (error) {
    observability?.log('runner.start.failed', { error: String(redact(String(error), [token])) });
    await cleanup();
    throw error;
  }
}

async function loadFixture(store: Store) {
  const taskId = 'fixture-implementation';
  const inputs = [
    {
      kind: 'task.updated',
      taskId,
      data: {
        title: 'Fixture: implement organization API',
        agent: 'backend',
        provider: 'simulated',
        status: 'awaiting approval',
      },
    },
    {
      kind: 'tool.updated',
      taskId,
      data: { tool: 'shell', command: 'npm test', status: 'waiting', fixture: true },
    },
    {
      kind: 'approval.requested',
      taskId,
      data: {
        id: randomUUID(),
        taskId,
        command: 'npm test (fixture only; nothing will execute)',
        state: 'pending',
        version: 1,
        fixture: true,
      },
    },
    {
      kind: 'context.updated',
      data: {
        generation: 'fixture-generation',
        roots: ['api', 'web'],
        precision: 'fixture — no source indexed',
        fixture: true,
      },
    },
    { kind: 'proof.updated', data: { requirement: 'AC-001', status: 'not_run', fixture: true } },
  ].map((input) => ({ ...input, id: randomUUID() }));
  await store.call('appendGroupIfAbsent', { taskId, inputs });
}

export class RunnerClient {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private traceContextEnabled = false;
  private requests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private constructor(
    socket: Socket,
    private token: string,
  ) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let newline: number;
      while ((newline = this.buffer.indexOf(10)) !== -1) {
        const frame = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (frame.length > MAX_FRAME_BYTES) {
          socket.destroy(new Error('RPC response exceeded frame limit.'));
          return;
        }
        try {
          const response = RpcResponse.parse(JSON.parse(frame.toString('utf8')));
          if (typeof response.id !== 'string') continue;
          const pending = this.requests.get(response.id);
          if (!pending) continue;
          this.requests.delete(response.id);
          clearTimeout(pending.timer);
          if (response.error)
            pending.reject(
              new Error(
                `${response.error.data?.code ?? response.error.code}: ${response.error.message}`,
              ),
            );
          else pending.resolve(response.result);
        } catch {
          socket.destroy(new Error('Invalid RPC response.'));
        }
      }
      if (this.buffer.length > MAX_FRAME_BYTES)
        socket.destroy(new Error('RPC response exceeded frame limit.'));
    });
    const fail = () => {
      for (const p of this.requests.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Runner disconnected; reconnect and reconcile state.'));
      }
      this.requests.clear();
    };
    socket.on('close', fail);
    socket.on('error', fail);
  }
  static async connect(paths: Paths, token?: string) {
    const credential = token ?? (await readFile(paths.token, 'utf8'));
    const socket = connect(paths.endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => socket.destroy(new Error('Runner connection timed out.')),
        2000,
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new RunnerClient(socket, credential);
  }
  request(
    method: Request['method'],
    params: Record<string, unknown> = {},
    timeout = 10000,
  ): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new Error('Runner client is disconnected.'));
    const id = randomUUID();
    const text =
      JSON.stringify({
        jsonrpc: '2.0',
        version: PROTOCOL_VERSION,
        id,
        token: this.token,
        method,
        params,
        ...(this.traceContextEnabled ? { traceContext: captureTraceContext() } : {}),
      }) + '\n';
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES)
      return Promise.reject(new Error('RPC request exceeds frame limit.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('RPC deadline exceeded.'));
      }, timeout);
      this.requests.set(id, {
        resolve: (value) => {
          if (method === 'ping')
            this.traceContextEnabled = Boolean(
              value &&
              typeof value === 'object' &&
              'capabilities' in value &&
              Array.isArray(value.capabilities) &&
              value.capabilities.includes('w3c-trace-context'),
            );
          resolve(value);
        },
        reject,
        timer,
      });
      this.socket.write(text);
    });
  }
  close() {
    this.socket.destroy();
  }
}

export async function ensureRunner(root: string, fixture = false) {
  const paths = await workspacePaths(root);
  const attach = async () => {
    const client = await RunnerClient.connect(paths);
    try {
      await client.request('ping', {}, 1000);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  };
  try {
    return await attach();
  } catch {
    /* launch below */
  }
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./main.js', import.meta.url)),
      '--root',
      paths.root,
      ...(fixture ? ['--fixture'] : []),
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  let startupError: Error | undefined;
  child.on('error', (error) => {
    startupError = error;
  });
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      return await attach();
    } catch {
      /* startup may still be in progress */
    }
    if (startupError || child.exitCode !== null)
      throw new Error(
        `Runner exited before readiness. Inspect ${paths.log} for schema, permissions, or native binding diagnostics.`,
        { cause: startupError },
      );
  }
  throw new Error(`Runner did not become ready. Inspect ${paths.log} and workspace permissions.`);
}
