import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { execa } from 'execa';
import {
  telemetry,
  captureTraceContext,
  traceCorrelation,
  withTraceContext,
  SpanKind,
} from '@kode/observability';
import { RpcRequest } from '@kode/contracts';
import { RunnerClient, startRunner, workspacePaths } from '@kode/runner';

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'kode-trace-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true, maxRetries: 5 });
});
describe('GAP-005 W3C context propagation', () => {
  test('isolates nested asynchronous contexts and ignores invalid headers without accepting arbitrary baggage', async () => {
    const root = await temporary();
    const otel = telemetry({ logFile: join(root, 'trace.log') });
    const traceId = '12345678901234567890123456789012';
    const carrier = {
      traceparent: `00-${traceId}-1234567890123456-01`,
      tracestate: 'kode=fixture',
    };
    try {
      const spans = await withTraceContext(carrier, () =>
        Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            otel.operation(`concurrent.${i}`, async () => {
              const before = captureTraceContext();
              expect(before.tracestate).toBe('kode=fixture');
              await new Promise((r) => setTimeout(r, (5 - i) * 10));
              expect(captureTraceContext()).toEqual(before);
              otel.log('nested.log');
              return traceCorrelation();
            }),
          ),
        ),
      );
      expect(spans.every((span) => span.trace_id === traceId)).toBe(true);
      expect(new Set(spans.map((span) => span.span_id)).size).toBe(5);
      expect(captureTraceContext()).toEqual({});
      expect(withTraceContext({ traceparent: 'not-a-header' }, captureTraceContext)).toEqual({});
      expect(
        withTraceContext(
          { traceparent: '00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-01' },
          captureTraceContext,
        ),
      ).toEqual({});
      const base = {
        jsonrpc: '2.0',
        version: 1,
        id: 'context',
        token: 'x'.repeat(64),
        method: 'ping',
      };
      expect(
        RpcRequest.safeParse({ ...base, traceContext: { tracestate: 'x'.repeat(513) } }).success,
      ).toBe(false);
      expect(
        RpcRequest.safeParse({ ...base, traceContext: { baggage: 'secret=value' } }).success,
      ).toBe(false);
      const logs = (await readFile(join(root, 'trace.log'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        logs.filter((log) => log.message === 'nested.log').every((log) => log.trace_id === traceId),
      ).toBe(true);
    } finally {
      await otel.close();
    }
  });

  test('real CLI processes, IPC, background jobs, durable events and OTLP logs share the right parent traces', async () => {
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
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const previousDisabled = process.env.OTEL_SDK_DISABLED;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
    delete process.env.OTEL_SDK_DISABLED;
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    let client: RunnerClient | undefined;
    const traceIds = ['11111111111111111111111111111111', '22222222222222222222222222222222'];
    const secret = 'fixture-trace-output-secret';
    try {
      runner = await startRunner(root);
      client = await RunnerClient.connect(runner.paths);
      for (const name of ['first', 'second']) {
        const path = join(root, name);
        await mkdir(path);
        await writeFile(
          join(path, 'kode.yaml'),
          JSON.stringify({
            version: 1,
            commands: {
              check: {
                run: ['node', '-e', 'setTimeout(()=>console.log(process.env.API_KEY),700)'],
                env: { API_KEY: secret },
              },
            },
          }),
        );
        await client.request('folder.add', { path, name, access: 'write' });
      }
      const results = await Promise.all(
        ['first', 'second'].map((name, i) =>
          execa(
            process.execPath,
            [
              resolve('apps/cli/dist/index.js'),
              '--root',
              root,
              '--json',
              'command',
              'run',
              name,
              'check',
            ],
            {
              env: {
                OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
                TRACEPARENT: `00-${traceIds[i]}-1234567890123456-01`,
                TRACESTATE: `kode=fixture${i}`,
              },
              windowsHide: true,
              timeout: 20000,
            },
          ),
        ),
      );
      for (const result of results) {
        expect(JSON.parse(result.stdout).status).toBe('passed');
        expect(result.stderr).toBe('');
        expect(result.stdout).not.toContain(secret);
      }
      const events = (await client.request('events.list')) as {
        kind: string;
        data: Record<string, unknown>;
      }[];
      const tools = events.filter((event) => event.kind === 'tool.updated');
      expect(tools.length).toBeGreaterThan(2);
      for (const tool of tools) {
        expect(tool.data.trace_id).toBe(traceIds[tool.data.root === 'first' ? 0 : 1]);
        expect(tool.data.span_id).toMatch(/^[a-f0-9]{16}$/);
      }
      await runner.close();
      runner = undefined;
      interface ExportSpan {
        name: string;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        traceState?: string;
        kind: number;
      }
      const spans: ExportSpan[] = received
        .filter((item) => item.path === '/v1/traces')
        .flatMap((item) =>
          JSON.parse(item.body).resourceSpans.flatMap(
            (resource: { scopeSpans: { spans: ExportSpan[] }[] }) =>
              resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        );
      const summary = [];
      for (const traceId of traceIds) {
        const chain = spans.filter((span) => span.traceId === traceId);
        const cli = chain.find((span) => span.name === 'cli.command')!;
        const rpc = chain.find((span) => span.name === 'rpc.job.start')!;
        const job = chain.find((span) => span.name === 'workspace.job')!;
        expect(cli).toBeDefined();
        expect(rpc).toBeDefined();
        expect(job).toBeDefined();
        expect(cli.parentSpanId).toBe('1234567890123456');
        expect(rpc.parentSpanId).toBe(cli.spanId);
        // OTLP reserves enum zero for unspecified; API SpanKind starts at internal zero.
        expect(rpc.kind).toBe(SpanKind.SERVER + 1);
        expect(job.traceState).toBe(`kode=fixture${traceIds.indexOf(traceId)}`);
        expect(job.parentSpanId).toBe(rpc.spanId);
        expect(
          tools
            .filter((event) => event.data.trace_id === traceId)
            .every((event) => event.data.span_id === job.spanId),
        ).toBe(true);
        expect(
          received
            .filter((item) => item.path === '/v1/logs')
            .some((item) => item.body.includes(job.spanId) && item.body.includes(traceId)),
        ).toBe(true);
        summary.push({ traceId, cli, rpc, job });
      }
      expect(JSON.stringify(received)).not.toContain(secret);
      expect(await readFile(join(root, '.kode', 'runner.log'), 'utf8')).not.toContain(secret);
      await mkdir('.artifacts', { recursive: true });
      await writeFile(
        '.artifacts/GAP-005-trace-context.json',
        JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            platform: process.platform,
            arch: process.arch,
            passed: true,
            chains: summary,
            durableActivityEvents: tools.length,
            checks: [
              'real CLI IPC propagation',
              'background job parentage',
              'concurrent trace isolation',
              'correlated logs and durable events',
              'redacted sinks',
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      client?.close();
      await runner?.close();
      if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous;
      if (previousDisabled === undefined) delete process.env.OTEL_SDK_DISABLED;
      else process.env.OTEL_SDK_DISABLED = previousDisabled;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30000);

  test('keeps legacy peers working by sending context only after capability negotiation', async () => {
    const root = await temporary(),
      paths = await workspacePaths(root);
    const requests: Record<string, unknown>[] = [];
    const server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (data: Buffer) => {
        buffer += data.toString();
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          requests.push(request);
          socket.write(
            JSON.stringify({ jsonrpc: '2.0', version: 1, id: request.id, result: { pong: true } }) +
              '\n',
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(paths.endpoint, r));
    const client = await RunnerClient.connect(paths, 'x'.repeat(64));
    try {
      await withTraceContext(
        { traceparent: '00-12345678901234567890123456789012-1234567890123456-01' },
        async () => {
          await client.request('ping');
          await client.request('status');
        },
      );
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => !('traceContext' in request))).toBe(true);
    } finally {
      client.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
