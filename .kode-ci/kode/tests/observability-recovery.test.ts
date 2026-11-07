import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { telemetry, withTraceContext } from '@kode/observability';
import { RunnerClient, ensureRunner, startRunner, workspacePaths } from '@kode/runner';
import { Store } from '@kode/storage';

const directories: string[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'kode-observability-'));
  directories.push(root);
  return root;
}
afterEach(async () => {
  for (const root of directories.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});
async function collector() {
  const bodies: { path: string; body: string }[] = [];
  let slow = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push({ path: request.url!, body: Buffer.concat(chunks).toString() });
      const reply = () => {
        if (!response.destroyed) {
          response.setHeader('content-type', 'application/json');
          response.end('{}');
        }
      };
      if (slow) setTimeout(reply, 1200).unref();
      else reply();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    bodies,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    delay(value: boolean) {
      slow = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test('standard SDK queue/drop/failure metrics remain locally visible through overload and recover without losing durable events', async () => {
  const root = await temporary(),
    receiver = await collector();
  receiver.delay(true);
  const secret = 'synthetic-backpressure-secret-005';
  const otel = telemetry({
    endpoint: receiver.endpoint,
    logFile: join(root, 'telemetry.log'),
    secrets: [secret],
  });
  const store = new Store(join(root, 'state.sqlite'));
  try {
    await store.append(
      {
        id: randomUUID(),
        kind: 'proof.updated',
        data: { status: 'not_run', fixture: true, password: secret },
      },
      [secret],
    );
    await Promise.all(
      Array.from({ length: 2000 }, () =>
        otel.operation('overload', async () => {
          otel.log(`output ${secret}`, { password: secret, output: 'x'.repeat(2048) });
        }),
      ),
    );
    const full = await otel.status();
    expect(full.traces.capacity).toBe(512);
    expect(full.logs.capacity).toBe(512);
    expect(full.traces.queued).toBeLessThanOrEqual(512);
    expect(full.logs.queued).toBeLessThanOrEqual(512);
    expect(full.traces.dropped).toBeGreaterThan(0);
    expect(full.logs.dropped).toBeGreaterThan(0);
    await pause(1800);
    const failed = await otel.status();
    expect(failed.traces.exportFailed + failed.logs.exportFailed).toBeGreaterThan(0);
    expect(failed.metricExportFailures).toBeGreaterThan(0);
    receiver.delay(false);
    await pause(600);
    await otel.operation('collector.recovered', async () => otel.log('resumed'));
    await otel.flush();
    const recovered = await otel.status();
    expect(recovered.traces.exported).toBeGreaterThan(0);
    expect(recovered.logs.exported).toBeGreaterThan(0);
    expect(recovered.traces.dropped).toBe(full.traces.dropped);
    expect(await store.list()).toHaveLength(1);
    expect(JSON.stringify(await store.list())).not.toContain(secret);
    expect(await readFile(join(root, 'telemetry.log'), 'utf8')).not.toContain(secret);
    expect(JSON.stringify(receiver.bodies)).not.toContain(secret);
    expect(
      receiver.bodies
        .filter((item) => item.path === '/v1/metrics')
        .some(
          (item) =>
            item.body.includes('otel.sdk.processor.span.processed') &&
            item.body.includes('queue_full'),
        ),
    ).toBe(true);
    await mkdir('.artifacts', { recursive: true });
    await writeFile(
      '.artifacts/GAP-005-backpressure.json',
      JSON.stringify(
        {
          passed: true,
          platform: process.platform,
          arch: process.arch,
          full,
          failed,
          recovered,
          durableEvents: 1,
        },
        null,
        2,
      ),
    );
  } finally {
    await store.close();
    await otel.close();
    await receiver.close();
  }
}, 20000);

test('a killed runner preserves job trace context, records unknown outcome on recovery, and never replays the action', async () => {
  const root = await temporary(),
    receiver = await collector();
  const oldEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = receiver.endpoint;
  const marker = join(root, 'dispatches.txt');
  const traceId = '33333333333333333333333333333333';
  let client: RunnerClient | undefined;
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  let pid: number | undefined;
  try {
    await writeFile(
      join(root, 'kode.yaml'),
      JSON.stringify({
        version: 1,
        commands: {
          work: {
            run: [
              'node',
              '-e',
              `require('node:fs').appendFileSync(${JSON.stringify(marker)},'once\\n');setTimeout(()=>{},5000)`,
            ],
          },
        },
      }),
    );
    client = await ensureRunner(root);
    pid = ((await client.request('ping')) as { pid: number }).pid;
    const registration = (await client.request('folder.add', {
      path: root,
      name: 'fixture',
      access: 'write',
    })) as { id: string };
    const job = (await withTraceContext(
      { traceparent: `00-${traceId}-1234567890123456-01`, tracestate: 'kode=crash' },
      () =>
        client!.request('job.start', { root: registration.id, kind: 'command', command: 'work' }),
    )) as { id: string };
    const deadline = Date.now() + 10000;
    while (!(await readFile(marker, 'utf8').catch(() => '')) && Date.now() < deadline)
      await pause(20);
    expect(await readFile(marker, 'utf8')).toContain('once');
    const paths = await workspacePaths(root);
    const before = JSON.parse(await readFile(join(paths.state, 'jobs', `${job.id}.json`), 'utf8'));
    expect(before.trace_id).toBe(traceId);
    expect(before.traceContext.tracestate).toBe('kode=crash');
    expect(before.status).toBe('running');
    expect(JSON.parse(await readFile(paths.lease, 'utf8')).pid).toBe(pid);
    process.kill(pid!, 'SIGKILL');
    pid = undefined;
    client.close();
    client = undefined;
    await pause(300);
    const legacyId = randomUUID(),
      invalidId = randomUUID();
    for (const [id, traceContext] of [
      [legacyId, undefined],
      [invalidId, { traceparent: 'invalid' }],
    ] as const)
      await writeFile(
        join(paths.state, 'jobs', `${id}.json`),
        JSON.stringify({
          id,
          root: registration.id,
          kind: 'command',
          status: 'running',
          traceContext,
        }),
      );
    runner = await startRunner(root);
    client = await RunnerClient.connect(runner.paths);
    await client.request('ping');
    const recovered = (await client.request('job.get', { id: job.id })) as typeof before;
    expect(recovered.status).toBe('blocked');
    expect(recovered.traceContext).toEqual(before.traceContext);
    expect(recovered.recovery).toMatchObject({ outcome: 'unknown', correlation: 'preserved' });
    for (const id of [legacyId, invalidId])
      expect(await client.request('job.get', { id })).toMatchObject({
        status: 'blocked',
        recovery: { correlation: 'unavailable', outcome: 'unknown' },
      });
    const events = (await client.request('events.list')) as {
      kind: string;
      data: Record<string, unknown>;
    }[];
    const recovery = events.find(
      (event) => event.data.recovery === true && event.data.jobId === job.id,
    )!;
    expect(recovery.data).toMatchObject({
      trace_id: traceId,
      replayed: false,
      status: 'blocked',
      outcome: 'unknown',
    });
    expect(recovery.data.span_id).not.toBe(before.span_id);
    client.close();
    client = undefined;
    await runner.close();
    runner = undefined;
    const spans = receiver.bodies
      .filter((item) => item.path === '/v1/traces')
      .flatMap((item) =>
        JSON.parse(item.body).resourceSpans.flatMap(
          (r: {
            scopeSpans: {
              spans: {
                name: string;
                traceId: string;
                spanId: string;
                parentSpanId?: string;
                attributes: unknown[];
              }[];
            }[];
          }) => r.scopeSpans.flatMap((s) => s.spans),
        ),
      );
    const reconcile = spans.find(
      (span) => span.name === 'workspace.job.reconcile' && span.traceId === traceId,
    )!;
    expect(reconcile.parentSpanId).toBe(before.span_id);
    expect(reconcile.spanId).toBe(recovery.data.span_id);
    expect(
      spans.some((span) => span.name === 'workspace.job' && span.spanId === before.span_id),
    ).toBe(false);
    runner = await startRunner(root);
    client = await RunnerClient.connect(runner.paths);
    expect(await client.request('job.get', { id: job.id })).toMatchObject({
      status: 'blocked',
      traceContext: before.traceContext,
    });
    const repeated = (await client.request('events.list')) as typeof events;
    expect(repeated.filter((event) => event.data.recovery === true)).toHaveLength(3);
    await pause(5200); // The bounded fixture child exits itself even though its parent was killed.
    expect((await readFile(marker, 'utf8')).match(/once/g)).toHaveLength(1);
    await mkdir('.artifacts', { recursive: true });
    await writeFile(
      '.artifacts/GAP-005-recovery.json',
      JSON.stringify(
        {
          passed: true,
          platform: process.platform,
          arch: process.arch,
          jobId: job.id,
          before,
          recovered,
          recovery: recovery.data,
          reconcile,
          actionDispatches: 1,
          repeatedRecoveryEvents: 3,
          legacyAndInvalidContext: 'explicitly unavailable',
        },
        null,
        2,
      ),
    );
  } finally {
    client?.close();
    await runner?.close();
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Owned runner already stopped. */
      }
    }
    await pause(100);
    await receiver.close();
    if (oldEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = oldEndpoint;
  }
}, 30000);
