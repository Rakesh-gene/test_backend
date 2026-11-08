import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execa } from 'execa';
import { ensureRunner, workspacePaths } from '@kode/runner';

const root = await mkdtemp(resolve('.artifacts/native-recovery-'));
await execa('git', ['init', root], { windowsHide: true });
const paths = await workspacePaths(root);
let client = await ensureRunner(root);
try {
  await client.request('folder.add', { path: root, name: 'probe', access: 'write' });
  const marker = join(root, 'must-not-execute.txt');
  const code = `require('fs').writeFileSync(${JSON.stringify(marker)},'executed')`;
  const task = await client.request('agent.start', {
    root: 'probe',
    prompt: `Disposable recovery qualification: use the shell exactly once to execute node -e ${JSON.stringify(code)}. Do not retry, use other tools, or edit any other files. If permission is unavailable stop.`,
    timeoutSeconds: 120,
  });
  let request;
  const deadline = Date.now() + 130000;
  while (!request && Date.now() < deadline) {
    request = (await client.request('approval.list')).find(
      (r) => r.taskId === task.id && r.state === 'pending',
    );
    const agent = await client.request('agent.get', { id: task.id });
    if (!request && !['running', 'awaiting approval'].includes(agent.status))
      throw new Error(`No live native request: ${agent.status} ${agent.error ?? ''}`);
    if (!request) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(request, 'No native request before timeout');
  assert.equal(
    await access(marker).then(
      () => true,
      () => false,
    ),
    false,
  );
  const owner = JSON.parse(await readFile(paths.lease, 'utf8'));
  // The PID comes from the new disposable workspace owned by this controller.
  process.kill(owner.pid, 'SIGKILL');
  client.close();
  await new Promise((r) => setTimeout(r, 500));
  client = await ensureRunner(root);
  const recovered = await client.request('approval.get', { id: request.id });
  const agent = await client.request('agent.get', { id: task.id });
  assert.equal(recovered.state, 'superseded');
  assert.equal(agent.status, 'blocked');
  assert.deepEqual(recovered.traceContext, request.traceContext);
  await assert.rejects(
    client.request('approval.decide', {
      id: request.id,
      version: request.version,
      fingerprint: request.fingerprint,
      choice: 'accept',
    }),
    /no longer attached/,
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    await access(marker).then(
      () => true,
      () => false,
    ),
    false,
  );
  await writeFile(
    '.artifacts/GAP-006-native-recovery.json',
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        arch: process.arch,
        root,
        recordedAt: new Date().toISOString(),
        pendingRequestId: request.id,
        recovered,
        agent,
        staleGrantRejected: true,
        commandReplayed: false,
        markerAbsent: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      recovered: recovered.state,
      agent: agent.status,
      commandReplayed: false,
    }),
  );
} finally {
  await client.request('shutdown').catch(() => {});
  client.close();
}
