import { mkdir, writeFile, readFile, mkdtemp, readdir } from 'node:fs/promises';
import { cpus, totalmem, tmpdir, release } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Store } from '@kode/storage';
import { grammarProbe } from '@kode/context';
import { providerInventory, codexProbe, codexPermissionProbe } from '@kode/providers';
import { telemetry } from '@kode/observability';
import { findExecutable, command } from '@kode/execution';

const require = createRequire(import.meta.url);
await mkdir('.artifacts', { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'kode-probe-'));
const checks = {};
async function check(name, action) {
  const start = Date.now();
  try {
    checks[name] = { status: 'pass', durationMs: Date.now() - start, result: await action() };
    checks[name].durationMs = Date.now() - start;
  } catch (error) {
    checks[name] = { status: 'fail', durationMs: Date.now() - start, error: String(error) };
  }
}
const executable = (name) => findExecutable(name);
await check('toolchain', async () => {
  const npm = await command(executable('npm'), ['--version']);
  const git = await command(executable('git'), ['--version']);
  if (process.version !== 'v24.22.1' || npm.stdout.trim() !== '11.19.1' || git.exitCode !== 0)
    throw new Error('Pinned toolchain mismatch.');
  return { node: process.version, npm: npm.stdout.trim(), git: git.stdout.trim() };
});
await check('sqlite', async () => {
  const path = join(scratch, 'probe.sqlite');
  let store = new Store(path);
  await store.append({
    id: randomUUID(),
    kind: 'context.updated',
    data: { symbol: 'greet', path: 'fixture.js', line: 1 },
  });
  await store.close();
  store = new Store(path);
  try {
    const events = await store.list();
    if (events.length !== 1) throw new Error('Persistence failed.');
    return { reopened: true, events: events.length };
  } finally {
    await store.close();
  }
});
await check('wasm', grammarProbe);
await check('otel', async () => {
  const received = [];
  const server = createHttpServer((request, response) => {
    request.resume();
    request.on('end', () => {
      received.push(request.url);
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const otel = telemetry({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    logFile: join(scratch, 'otel.log'),
  });
  try {
    await otel.operation('p00.local.probe', async () => {});
    await otel.flush();
    if (!['/v1/traces', '/v1/logs', '/v1/metrics'].every((p) => received.includes(p)))
      throw new Error('Missing OTLP signal.');
    return { received };
  } finally {
    await otel.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
if (!executable('codex'))
  checks.codexProtocol = {
    status: 'blocked',
    reason: 'Codex CLI is not installed; protocol and live checks require it.',
  };
else
  await check('codexProtocol', async () => {
    const result = await codexProbe({ cwd: scratch });
    return {
      initialization: result.initialization,
      models: result.models.data.map((m) => ({
        id: m.id,
        efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
      })),
      authenticated: Boolean(result.account.account),
      inference: 'not_run',
    };
  });
const providers = await providerInventory();
const capabilities = {
  codex: {
    integration: 'app-server',
    sdk: 'installed CLI',
    sessions: 'protocol',
    approval: 'JSON-RPC requests',
    reasoning: 'model/list',
    liveStatus: 'not_run',
  },
  claude: {
    integration: 'Agent SDK',
    sdk: JSON.parse(
      await readFile(
        join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'),
        'utf8',
      ),
    ).version,
    sessions: 'documented, not live-verified',
    approval: 'canUseTool, not live-verified',
    authentication: process.env.ANTHROPIC_API_KEY
      ? 'API key present, not verified'
      : 'API key absent',
    liveStatus: 'blocked without verified API authentication',
  },
  copilot: {
    integration: 'Copilot SDK',
    sessions: 'documented, not live-verified',
    approval: 'onPermissionRequest, not live-verified',
    authentication: 'unknown',
    liveStatus: 'not_run',
  },
};
if (process.argv.includes('--live-codex'))
  await check('codexLive', () => codexProbe({ cwd: scratch, live: true }));
if (process.argv.includes('--codex-permissions')) {
  await check('codexApprove', () => codexPermissionProbe(scratch, 'accept'));
  await check('codexDeny', () => codexPermissionProbe(scratch, 'decline'));
}

let xerjPath = process.env.KODE_XERJ_PATH ?? executable('xerj');
if (!xerjPath) {
  const installed = await readFile(resolve('.tools/xerj/installed.json'), 'utf8').catch(() => null);
  if (installed) {
    const asset = JSON.parse(installed);
    const bytes = await readFile(asset.binary);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.binarySha256)
      throw new Error('Installed XERJ binary checksum mismatch; run setup-xerj again.');
    xerjPath = asset.binary;
  }
}
if (!xerjPath && process.platform === 'win32') {
  const base = resolve('.tools/xerj/bin');
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory()) xerjPath = join(base, entry.name, 'xerj.exe');
}
if (!xerjPath)
  checks.xerj = {
    status: 'blocked',
    reason: 'Set KODE_XERJ_PATH to the checksum-verified platform binary.',
  };
else
  await check('xerj', async () => {
    const reservation = createServer();
    await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const data = join(scratch, 'xerj-data');
    const url = `http://127.0.0.1:${port}`;
    const relaxed = process.argv.includes('--probe-relax-disk-watermark');
    const config = join(scratch, 'xerj-probe.toml');
    if (relaxed) await writeFile(config, '[limits]\ndisk_flood_stage_percent = 99\n');
    const child = spawn(
      xerjPath,
      [
        ...(relaxed ? ['--config', config] : []),
        '--insecure',
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--data-dir',
        data,
        '--disable-feedback',
        '--embed-mode',
        'lexical',
      ],
      { windowsHide: true, stdio: 'pipe', env: { ...process.env, XERJ_DISABLE_FEEDBACK: 'true' } },
    );
    let errors = '';
    child.stdout.resume();
    child.stderr.on('data', (x) => {
      errors = (errors + x.toString()).slice(-4000);
    });
    let exited = false;
    child.on('exit', () => {
      exited = true;
    });
    child.on('error', (e) => {
      errors += String(e);
      exited = true;
    });
    const request = async (path, options = {}) => {
      const response = await fetch(url + path, {
        ...options,
        signal: AbortSignal.timeout(2000),
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok)
        throw new Error(`XERJ ${path}: ${response.status} ${await response.text()}`);
      return response.json();
    };
    try {
      let ready = false;
      const deadline = Date.now() + 20000;
      while (!ready && !exited && Date.now() < deadline) {
        try {
          await request('/');
          ready = true;
        } catch {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (!ready) throw new Error(`XERJ did not start: ${errors}`);
      await request('/kode-p00', {
        method: 'PUT',
        body: JSON.stringify({
          mappings: {
            properties: {
              body: { type: 'text' },
              path: { type: 'keyword' },
              line: { type: 'integer' },
            },
          },
        }),
      });
      const fixtureSource = 'export function organizationAuthentication() { return true; }\n';
      await writeFile(join(scratch, 'fixture.ts'), fixtureSource);
      const contentHash = createHash('sha256').update(fixtureSource).digest('hex');
      await request('/kode-p00/_doc/fixture?refresh=true', {
        method: 'PUT',
        body: JSON.stringify({
          body: fixtureSource,
          path: 'fixture.ts',
          line: 1,
          contentHash,
        }),
      });
      const result = await request('/kode-p00/_search', {
        method: 'POST',
        body: JSON.stringify({ query: { match: { body: 'organizationAuthentication' } } }),
      });
      if (
        result.hits.hits[0]?._source.path !== 'fixture.ts' ||
        result.hits.hits[0]?._source.contentHash !== contentHash ||
        result.hits.hits[0]?._source.body !== (await readFile(join(scratch, 'fixture.ts'), 'utf8'))
      )
        throw new Error('Expected cited fixture was not returned.');
      return {
        binary: xerjPath,
        sha256: createHash('sha256')
          .update(await readFile(xerjPath))
          .digest('hex'),
        fixture: result.hits.hits[0]._source,
        fixtureBytes: Buffer.byteLength(fixtureSource),
        loopbackOnly: true,
        feedbackDisabled: true,
        probeWatermarkPercent: relaxed ? 99 : 95,
      };
    } finally {
      child.kill();
      const until = Date.now() + 3000;
      while (!exited && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      if (!exited) child.kill('SIGKILL');
    }
  });

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  os: release(),
  hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  providers,
  capabilities,
  checks,
  limitations: [
    'Only this host was exercised; CI matrix execution is separate.',
    'Native approve/deny requires live authenticated providers and is not established by fixture decisions.',
    'No performance claim is established by a feasibility fixture.',
  ],
};
await writeFile('.artifacts/P00-probes.json', JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    report: '.artifacts/P00-probes.json',
    checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.status])),
  }),
);
if (Object.values(checks).some((c) => c.status === 'fail')) process.exitCode = 1;
if (process.argv.includes('--require-local')) {
  const required = ['toolchain', 'sqlite', 'wasm', 'otel', 'xerj'];
  if (required.some((name) => checks[name]?.status !== 'pass')) process.exitCode = 1;
}
