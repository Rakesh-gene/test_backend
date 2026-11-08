import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execa } from 'execa';
import { ensureRunner, workspacePaths } from '@kode/runner';

const root = await mkdtemp(resolve('.artifacts/strict-containment-'));
await execa('git', ['init', root], { windowsHide: true });
const image = process.env.KODE_CONTAINER_IMAGE ?? 'mcr.microsoft.com/dotnet/sdk:10.0';
process.env.KODE_CONTAINMENT_HOST_SECRET = 'synthetic-host-only-value';
const commands = {
  scope: {
    run: [
      'sh',
      '-c',
      `set -eu
test "$(id -u)" != 0
test -z "\${KODE_CONTAINMENT_HOST_SECRET:-}"
test ! -e /var/run/docker.sock
if echo escaped >/outside.txt 2>/dev/null; then exit 71; fi
if echo escaped >/workspace/.kode/control.token 2>/dev/null; then exit 72; fi
if kill -TERM 1 2>/dev/null; then exit 73; fi
echo allowed >/workspace/allowed.txt
echo KODE_STRICT_SCOPE_OK`,
    ],
  },
  direct: {
    run: [
      'sh',
      '-c',
      "setsid sh -c 'sleep 3; echo escaped >/workspace/escaped-direct.txt' >/dev/null 2>&1 & echo ready >/workspace/ready-direct.txt",
    ],
  },
  crash: {
    run: [
      'sh',
      '-c',
      "setsid sh -c 'sleep 3; echo escaped >/workspace/escaped-crash.txt' >/dev/null 2>&1 & echo ready >/workspace/ready-crash.txt; sleep 30",
    ],
  },
  timeout: {
    run: ['sh', '-c', 'echo ready >/workspace/ready-timeout.txt; sleep 30'],
    timeout_seconds: 3,
  },
};
await writeFile(join(root, 'kode.yaml'), JSON.stringify({ version: 1, commands }));
const paths = await workspacePaths(root);
let client = await ensureRunner(root);
const wait = async (read, check, timeout = 20000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (check(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Container acceptance timed out');
};
const results = [];
try {
  const repo = await client.request('folder.add', { path: root, name: 'probe', access: 'write' });
  const tree = await client.request('tree.create', { root: repo.id });
  const policy = await client.request('execution.configure', { mode: 'container', image });
  assert.match(policy.image, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(
    client.request('job.start', { root: repo.id, kind: 'command', command: 'scope' }),
    /isolated task tree/,
  );
  await assert.rejects(
    client.request('job.start', { root: repo.id, tree: tree.id, kind: 'environment' }),
    /disabled in container mode/,
  );
  for (const command of ['scope', 'direct', 'timeout', 'crash']) {
    const job = await client.request('job.start', {
      root: repo.id,
      tree: tree.id,
      kind: 'command',
      command,
    });
    if (command === 'crash') {
      await wait(
        () =>
          access(join(tree.path, 'ready-crash.txt')).then(
            () => true,
            () => false,
          ),
        Boolean,
      );
      const owned = await readdir(join(paths.control, 'containers'));
      assert.equal(owned.length, 1);
      const descriptor = JSON.parse(
        await readFile(join(paths.control, 'containers', owned[0]), 'utf8'),
      );
      const inspected = JSON.parse(
        (
          await execa(
            'docker',
            ['--host', descriptor.endpoint, 'inspect', descriptor.id, '--format', '{{json .}}'],
            { windowsHide: true },
          )
        ).stdout,
      );
      assert.equal(inspected.HostConfig.NetworkMode, 'none');
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
      assert.equal(inspected.Config.StdinOnce, true);
      assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
      assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges'));
      assert.deepEqual(
        inspected.Mounts.filter((mount) => mount.Type === 'bind').map((mount) => mount.Destination),
        ['/workspace'],
      );
      const owner = JSON.parse(await readFile(paths.lease, 'utf8'));
      process.kill(owner.pid, 'SIGKILL');
      client.close();
      // Check automatic EOF/namespace teardown before starting recovery.
      await wait(
        async () => {
          const check = await execa(
            'docker',
            ['--host', descriptor.endpoint, 'inspect', descriptor.id],
            {
              reject: false,
              windowsHide: true,
            },
          );
          return check.exitCode !== 0;
        },
        Boolean,
        10000,
      );
      await new Promise((r) => setTimeout(r, 3500));
      assert.equal(
        await access(join(tree.path, 'escaped-crash.txt')).then(
          () => true,
          () => false,
        ),
        false,
      );
      client = await ensureRunner(root);
      const recovered = await client.request('job.get', { id: job.id });
      assert.equal(recovered.status, 'blocked');
      assert.equal((await readdir(join(paths.control, 'containers'))).length, 0);
      results.push({
        command,
        containerGoneBeforeRecovery: true,
        escapedWrite: false,
        recovered: recovered.status,
        replayed: false,
      });
    } else {
      const final = await wait(
        () => client.request('job.get', { id: job.id }),
        (x) => x.status !== 'running',
      );
      assert.equal(
        final.status,
        command === 'timeout' ? 'timed_out' : 'passed',
        JSON.stringify(final),
      );
      if (command === 'scope') assert.ok(final.result.stdout.includes('KODE_STRICT_SCOPE_OK'));
      if (command === 'direct') {
        await new Promise((r) => setTimeout(r, 3500));
        assert.equal(
          await access(join(tree.path, 'escaped-direct.txt')).then(
            () => true,
            () => false,
          ),
          false,
        );
      }
      results.push({
        command,
        status: final.status,
        execution: final.execution,
        result: final.result,
      });
    }
  }
  assert.equal(
    await access(join(root, 'allowed.txt')).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(await readFile(join(tree.path, 'allowed.txt'), 'utf8'), 'allowed\n');
  await writeFile(
    '.artifacts/GAP-007-container.json',
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        arch: process.arch,
        root,
        image: policy.image,
        recordedAt: new Date().toISOString(),
        results,
        sourcePreserved: true,
        hostSecretExcluded: true,
        guardProtected: true,
        dockerSocketAbsent: true,
        mounts: 'selected isolated task tree only',
        network: 'none',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, scenarios: results.length, image: policy.image }));
} finally {
  await client.request('shutdown').catch(() => {});
  client.close();
}
