import { spawn } from 'node-pty';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RunnerClient, workspacePaths } from '@kode/runner';
import { safeTerminal } from '@kode/contracts';

const root = await mkdtemp(join(tmpdir(), 'kode-terminal-'));
await mkdir('.artifacts', { recursive: true });
let output = '';
const terminal = spawn(
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
    cols: 110,
    rows: 35,
    cwd: process.cwd(),
    // This child is an actual interactive PTY even when its test driver is in CI.
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
  output += data;
});
let exited = false;
let exitDetails;
terminal.onExit((details) => {
  exited = true;
  exitDetails = details;
});
const waitFor = async (text) => {
  const deadline = Date.now() + 45000;
  while (!safeTerminal(output).includes(text) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  if (!safeTerminal(output).includes(text)) {
    await writeFile('.artifacts/terminal-failure.txt', output);
    throw new Error(
      `Terminal did not display: ${text}. Exit: ${JSON.stringify(exitDetails)}. Last output: ${safeTerminal(output).slice(-1000)}`,
    );
  }
};
let client;
try {
  await waitFor('FIXTURE MODE');
  client = await RunnerClient.connect(await workspacePaths(root));
  terminal.write('4');
  await waitFor('SIMULATED request');
  terminal.write('y');
  await new Promise((r) => setTimeout(r, 200));
  const before = await client.request('events.list');
  if (before.some((e) => e.kind === 'approval.resolved'))
    throw new Error('Unarmed keypress granted approval.');
  terminal.write('\r');
  await waitFor('Confirm selected fixture request');
  terminal.write('n');
  await waitFor('Fixture decision recorded.');
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(
    join(project, 'kode.yaml'),
    JSON.stringify({
      version: 1,
      commands: {
        'p03-terminal-check': { run: ['node', '-e', "setTimeout(()=>console.log('done'),700)"] },
      },
    }),
  );
  await client.request('folder.add', { path: project, name: 'terminal-project', access: 'write' });
  terminal.write('1');
  await waitFor('terminal-project');
  const liveJob = await client.request('job.start', {
    root: 'terminal-project',
    kind: 'command',
    command: 'p03-terminal-check',
  });
  terminal.write('3');
  await waitFor('p03-terminal-check');
  let liveResult;
  do {
    await new Promise((r) => setTimeout(r, 100));
    liveResult = await client.request('job.get', { id: liveJob.id });
  } while (liveResult.status === 'running');
  if (liveResult.status !== 'passed') throw new Error('Live terminal command failed.');
  terminal.resize(58, 32);
  await new Promise((r) => setTimeout(r, 200));
  terminal.write('5');
  await waitFor('Real indexing and freshness');
  terminal.resize(130, 38);
  terminal.write('/fixture\r');
  await new Promise((r) => setTimeout(r, 100));
  terminal.write('\x1b');
  terminal.write('q');
  await waitFor('KODE_APP_EXIT=0');
  await writeFile('.artifacts/terminal-capture.txt', output);
  const summary = {
    passed: true,
    platform: process.platform,
    arch: process.arch,
    fixture: true,
    checks: [
      'rich render',
      'pane navigation',
      'no unarmed approval',
      'explicit deny',
      'registered roots and live command activity',
      'narrow/wide resize',
      'search',
      'clean detach',
    ],
    bytes: Buffer.byteLength(output),
  };
  await writeFile('.artifacts/terminal-result.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  if (client) {
    await client.request('shutdown').catch(() => {});
    client.close();
  }
  if (!exited) terminal.kill();
}
