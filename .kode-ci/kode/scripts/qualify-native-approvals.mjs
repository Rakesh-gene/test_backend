// Explicit native acceptance: controller decisions apply only to owned marker commands.
import assert from 'node:assert/strict';
import { execa } from 'execa';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startRunner, RunnerClient } from '@kode/runner';
import { spawn } from 'node-pty';
import { safeTerminal } from '@kode/contracts';
const root = await mkdtemp(resolve('.artifacts/native-approval-'));
await execa('git', ['init', root], { windowsHide: true });
const runner = await startRunner(root);
const client = await RunnerClient.connect(runner.paths);
await client.request('folder.add', { path: root, name: 'probe', access: 'write' });
await writeFile(join(runner.paths.control, 'canary.txt'), 'synthetic-canary');
let output = '',
  pty;
const wait = async (text, timeout = 90000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until && !safeTerminal(output).includes(text))
    await new Promise((r) => setTimeout(r, 25));
  assert.ok(
    safeTerminal(output).includes(text),
    `Missing UI ${text}: ${safeTerminal(output).slice(-1200)}`,
  );
};
const scenarios = [];
try {
  pty = spawn(
    process.execPath,
    [resolve('scripts/terminal-host.mjs'), resolve('apps/cli/dist/index.js'), '--root', root],
    {
      name: 'xterm-256color',
      cols: 130,
      rows: 45,
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
  pty.onData((data) => {
    output = (output + data).slice(-128000);
  });
  await wait('connected');
  for (const mode of ['deny', 'approve', 'approved-failure']) {
    const code = `console.log('KODE_GAP006_MARKER');process.exit(${mode === 'approved-failure' ? 7 : 0})`;
    const command = `node -e ${JSON.stringify(code)}`;
    const task = await client.request('agent.start', {
      root: 'probe',
      prompt: `This is a disposable native permission test. Use the shell tool exactly once to execute this exact command: ${command}. Do not edit files, access the network, retry, or use other commands/tools. If denied say DENIED and stop. After a command result say DONE and stop.`,
      timeoutSeconds: 120,
    });
    const until = Date.now() + 125000;
    let requests = [],
      agent;
    while (Date.now() < until) {
      agent = await client.request('agent.get', { id: task.id });
      requests = (await client.request('approval.list')).filter(
        (r) => r.taskId === task.id && r.state === 'pending',
      );
      if (requests.length) break;
      if (['blocked', 'completed', 'failed', 'cancelled'].includes(agent.status)) {
        throw new Error(`No native request: ${JSON.stringify(agent)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request.command.includes('KODE_GAP006') && request.command.includes('node'));
    pty.write('1');
    await new Promise((r) => setTimeout(r, 80));
    output = '';
    pty.write('4');
    await wait('native command');
    pty.write('y');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await client.request('approval.get', { id: request.id })).state, 'pending');
    output = '';
    pty.write('\r');
    await wait('Confirm native request');
    pty.write(mode === 'deny' ? 'n' : 'y');
    while (Date.now() < until) {
      agent = await client.request('agent.get', { id: task.id });
      if (!['running', 'awaiting approval'].includes(agent.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const final = await client.request('approval.get', { id: request.id });
    if (final.state !== 'resolved') {
      await writeFile(
        '.artifacts/GAP-006-native-failure.json',
        JSON.stringify({ mode, agent, final, output: safeTerminal(output) }, null, 2),
      );
    }
    assert.equal(final.state, 'resolved');
    assert.equal(
      final.decision,
      mode === 'deny' ? (request.choices.includes('decline') ? 'decline' : 'cancel') : 'accept',
    );
    if (mode === 'approved-failure') assert.equal(final.outcome, 'failed');
    scenarios.push({ mode, agent, request: final });
    await writeFile(
      '.artifacts/GAP-006-native.json',
      JSON.stringify(
        {
          passed: scenarios.length === 3,
          platform: process.platform,
          arch: process.arch,
          root,
          scenarios,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ mode, status: agent.status, delivery: final.state, outcome: final.outcome }),
    );
  }
  pty.write('q');
  await wait('KODE_APP_EXIT=0');
  await writeFile(
    '.artifacts/GAP-006-native.json',
    JSON.stringify(
      { passed: true, platform: process.platform, arch: process.arch, root, scenarios },
      null,
      2,
    ),
  );
} finally {
  pty?.kill();
  client.close();
  await runner.close();
}
