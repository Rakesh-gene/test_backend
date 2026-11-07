import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node-pty';
import { Store } from '@kode/storage';
import { RunnerClient, startRunner } from '@kode/runner';
import { telemetry, traceCorrelation, withTraceContext } from '@kode/observability';
import { safeTerminal, emptyView, projectEvent } from '@kode/contracts';

const duration = Number(process.env.KODE_LOAD_SECONDS ?? 600);
assert.ok(Number.isInteger(duration) && duration >= 10 && duration <= 3600);
await mkdir('.artifacts', { recursive: true });
const root = await mkdtemp(resolve('.artifacts/observability-load-'));
let mode = 'healthy',
  bodies = 0,
  receivedBytes = 0;
const collector = createServer((request, response) => {
  request.on('data', (chunk) => {
    receivedBytes += chunk.length;
  });
  request.on('end', () => {
    bodies++;
    if (mode === 'outage') {
      request.socket.destroy();
      return;
    }
    const reply = () => {
      if (!response.destroyed) {
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      }
    };
    if (mode === 'slow') setTimeout(reply, 1500).unref();
    else reply();
  });
});
await new Promise((r) => collector.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${collector.address().port}`;
const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const previousDisabled = process.env.OTEL_SDK_DISABLED;
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
delete process.env.OTEL_SDK_DISABLED;
const secret = 'qualification-synthetic-secret-005';
const otel = telemetry({ endpoint, logFile: join(root, 'load.log'), secrets: [secret] });
const runner = await startRunner(root, { testing: true });
const client = await RunnerClient.connect(runner.paths);
const store = new Store(runner.paths.database);
await store.ready;
let terminal,
  output = '',
  capturedBytes = 0;
const keyLatency = [],
  pingLatency = [],
  samples = [],
  approvals = [];
let produced = 0,
  initial,
  failure;
const view = emptyView();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (text, timeout = 15000) => {
  const end = performance.now() + timeout;
  while (!safeTerminal(output).includes(text) && performance.now() < end) await pause(5);
  assert.ok(safeTerminal(output).includes(text), `PTY did not display ${text}`);
};
async function denyVisible(command, id) {
  output = '';
  terminal.write('4');
  await waitFor(command);
  output = '';
  terminal.write('\r');
  await waitFor('Confirm selected fixture request');
  terminal.write('n');
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const found = await store.call('countDecision', { requestId: id });
    if (found === 1) {
      await pause(100);
      return;
    }
    await pause(20);
  }
  throw new Error('PTY approval decision was not durably recorded.');
}
try {
  await client.request('fixture.load');
  const agents = [
    'fixture-implementation',
    ...Array.from({ length: 4 }, (_, i) => `load-agent-${i + 1}`),
  ];
  for (const agent of agents.slice(1))
    await store.append({
      id: randomUUID(),
      kind: 'task.updated',
      taskId: agent,
      data: {
        title: 'Synthetic load assignment',
        agent,
        provider: 'simulated',
        status: 'running',
        fixture: true,
      },
    });
  for (let i = 0; i < 10000; i++)
    await store.append({
      id: randomUUID(),
      kind: 'tool.updated',
      taskId: agents[i % 5],
      data: { fixture: true, phase: 'history', status: 'passed', name: 'history' },
    });
  initial = (await store.call('count')).events;
  terminal = spawn(
    process.execPath,
    [
      resolve('scripts/terminal-host.mjs'),
      resolve('apps/cli/dist/index.js'),
      '--root',
      root,
      '--fixture',
    ],
    {
      name: 'xterm-256color',
      cols: 130,
      rows: 40,
      cwd: process.cwd(),
      env: {
        ...process.env,
        CI: 'false',
        CONTINUOUS_INTEGRATION: 'false',
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      },
    },
  );
  terminal.onData((data) => {
    capturedBytes += Buffer.byteLength(data);
    output = (output + data).slice(-128000);
  });
  await waitFor('FIXTURE MODE');
  const fixtureApproval = (await store.list(0, 100)).find((e) => e.kind === 'approval.requested');
  await denyVisible(fixtureApproval.data.command, fixtureApproval.data.id);
  approvals.push(fixtureApproval.data.id);
  const start = performance.now(),
    rssStart = process.memoryUsage().rss;
  let nextKey = 0,
    nextSample = 0,
    nextApproval = Math.min(30, duration / 4),
    maxRecent = 0;
  const rate = 200;
  let overloadBursts = 0;
  for (let tick = 0; tick < duration * 10; tick++) {
    const elapsed = (performance.now() - start) / 1000;
    mode =
      elapsed < duration / 4 || elapsed >= (duration * 3) / 4
        ? 'healthy'
        : elapsed < duration / 2
          ? 'slow'
          : 'outage';
    if (!overloadBursts && elapsed >= duration / 4) {
      await Promise.all(
        Array.from({ length: 2000 }, () =>
          otel.operation('qualification.overload.burst', async () =>
            otel.log('synthetic telemetry burst'),
          ),
        ),
      );
      overloadBursts++;
    }
    await Promise.all(
      Array.from({ length: 20 }, (_, n) => {
        const index = produced + n,
          agent = index % 5;
        return withTraceContext(
          { traceparent: `00-${String(agent + 1).repeat(32)}-1234567890123456-01` },
          () =>
            otel.operation('qualification.event', async () => {
              otel.log(`output ${secret}`, { agent, password: secret });
              await store.append(
                {
                  id: randomUUID(),
                  kind: 'tool.updated',
                  taskId: agents[agent],
                  data: {
                    fixture: true,
                    name: 'load',
                    phase: 'command',
                    status: 'running',
                    agent,
                    message: `bounded output ${secret}`,
                    ...traceCorrelation(),
                  },
                },
                [secret],
              );
            }),
        );
      }),
    );
    produced += 20;
    if (elapsed >= nextKey) {
      terminal.write('1');
      await pause(50);
      const marker = `latency${tick}`;
      terminal.write('/');
      await waitFor('Search:');
      const keyStart = performance.now();
      terminal.write(marker);
      await waitFor(marker, 5000);
      keyLatency.push(performance.now() - keyStart);
      terminal.write('\r');
      await pause(30);
      terminal.write('\x1b');
      nextKey = elapsed + 5;
    }
    if (elapsed >= nextSample) {
      const pingStart = performance.now();
      await client.request('ping');
      pingLatency.push(performance.now() - pingStart);
      const health = await otel.status();
      assert.ok(health.traces.queued <= 512 && health.logs.queued <= 512);
      let page;
      do {
        page = await store.list(view.cursor, 100);
        for (const event of page) {
          assert.ok(!JSON.stringify(event).includes(secret));
          projectEvent(view, event);
          maxRecent = Math.max(maxRecent, view.events.length);
        }
      } while (page.length === 100);
      assert.ok(view.events.length <= 200);
      samples.push({
        elapsed,
        mode,
        produced,
        health,
        rss: process.memoryUsage().rss,
        recent: view.events.length,
      });
      if (samples.length % 10 === 1)
        console.log(JSON.stringify({ elapsed: Math.round(elapsed), mode, produced, health }));
      nextSample = elapsed + 3;
    }
    if (elapsed >= nextApproval && elapsed < duration - 3) {
      const id = randomUUID(),
        command = `LOAD_APPROVAL_${approvals.length}`;
      await store.append({
        id: randomUUID(),
        kind: 'approval.requested',
        data: { id, taskId: agents[0], command, state: 'pending', version: 1, fixture: true },
      });
      await denyVisible(command, id);
      approvals.push(id);
      nextApproval = elapsed + Math.min(60, duration / 4);
    }
    const due = start + (tick + 1) * 100;
    if (performance.now() < due) await pause(due - performance.now());
  }
  mode = 'healthy';
  await otel.flush();
  const health = await otel.status();
  const sorted = (values) => [...values].sort((a, b) => a - b);
  const p95 = (values) => sorted(values)[Math.ceil(values.length * 0.95) - 1];
  assert.ok(p95(keyLatency) <= 250, `PTY key p95 ${p95(keyLatency)} exceeds 250 ms`);
  assert.ok(p95(pingLatency) <= 250, `Ping p95 ${p95(pingLatency)} exceeds 250 ms`);
  assert.equal(produced, duration * rate);
  assert.ok(
    health.traces.dropped + health.logs.dropped > 0,
    'Backpressure did not exercise queue overflow',
  );
  assert.ok(health.traces.exportFailed + health.logs.exportFailed > 0);
  assert.ok(health.traces.exported > 0 && health.logs.exported > 0);
  for (const id of approvals) assert.equal(await store.call('countDecision', { requestId: id }), 1);
  const count = (await store.call('count')).events;
  assert.equal(count, initial + produced + (approvals.length - 1) + approvals.length);
  assert.ok(view.tasks.size === 5 && maxRecent === 200);
  const elapsedSeconds = (performance.now() - start) / 1000;
  const observedRate = produced / elapsedSeconds;
  if (duration >= 600)
    assert.ok(
      observedRate >= 190,
      `Observed event rate ${observedRate} missed the 200/s target by more than 5%`,
    );
  const report = {
    passed: true,
    qualification:
      duration >= 600 ? 'ten-minute sustained native PTY qualification' : 'short regression only',
    recordedAt: new Date().toISOString(),
    platform: platform(),
    release: release(),
    arch: process.arch,
    node: process.version,
    hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemory: totalmem() },
    root,
    durationSeconds: duration,
    elapsedSeconds,
    observedEventsPerSecond: observedRate,
    normalizedEventsPerSecond: rate,
    overloadBursts,
    produced,
    agents: 5,
    retainedInitialHistory: 10000,
    durableEvents: count,
    approvalsResolvedExactlyOnce: approvals.length,
    keySamples: keyLatency.length,
    keyP95Ms: p95(keyLatency),
    pingP95Ms: p95(pingLatency),
    maxRecentEvents: maxRecent,
    captureRetainedChars: output.length,
    capturedBytes,
    collectorRequests: bodies,
    collectorBytes: receivedBytes,
    rssStart,
    rssEnd: process.memoryUsage().rss,
    health,
    samples,
  };
  await writeFile('.artifacts/GAP-005-load.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      qualification: report.qualification,
      produced,
      keyP95Ms: report.keyP95Ms,
      report: '.artifacts/GAP-005-load.json',
    }),
  );
} catch (error) {
  failure = error;
  await writeFile(
    '.artifacts/GAP-005-load-failure.json',
    JSON.stringify({ passed: false, error: String(error), produced, samples }, null, 2),
  );
} finally {
  terminal?.kill();
  client.close();
  await store.close();
  await runner.close();
  await otel.close();
  collector.closeAllConnections();
  await new Promise((r) => collector.close(r));
  if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
  if (previousDisabled === undefined) delete process.env.OTEL_SDK_DISABLED;
  else process.env.OTEL_SDK_DISABLED = previousDisabled;
}
if (failure) throw failure;
