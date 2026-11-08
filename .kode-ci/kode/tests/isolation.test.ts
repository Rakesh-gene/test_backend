import { test, expect } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Workspace,
  RepoManifest,
  runDeclared,
  withExecution,
  executionPolicy,
} from '@kode/workspace';
import { startRunner, RunnerClient } from '@kode/runner';

test('strict execution rejects remote/unavailable engines without a native fallback, and invalid policies cannot dispatch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-isolation-'));
  const old = process.env.DOCKER_HOST;
  try {
    const workspace = new Workspace(home);
    await workspace.init();
    const control = join(workspace.state, 'control');
    await mkdir(control, { recursive: true });
    const repo = join(home, 'repo');
    await mkdir(repo);
    const marker = join(repo, 'must-not-run');
    const manifest = RepoManifest.parse({
      version: 1,
      commands: {
        dangerous: {
          run: [process.execPath, '-e', "require('fs').writeFileSync('must-not-run','executed')"],
        },
      },
    });
    process.env.DOCKER_HOST = 'tcp://remote.invalid:2375';
    await expect(
      withExecution(
        {
          root: repo,
          control,
          policy: { mode: 'container', image: `sha256:${'0'.repeat(64)}`, reference: 'fixture' },
        },
        () => runDeclared(repo, manifest, 'dangerous'),
      ),
    ).rejects.toThrow(/local Docker|requires Docker/);
    expect(
      await access(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await writeFile(
      join(control, 'execution.json'),
      JSON.stringify({ mode: 'container', image: 'mutable:tag', reference: 'invalid' }),
    );
    await expect(executionPolicy(workspace.state)).rejects.toThrow();
  } finally {
    if (old === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = old;
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('runner requires isolated trees for strict commands and rejects native environment receipts in container mode', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-policy-'));
  const runner = await startRunner(home);
  const client = await RunnerClient.connect(runner.paths);
  try {
    const repo = join(home, 'repo');
    await mkdir(repo);
    const root = (await client.request('folder.add', {
      path: repo,
      name: 'repo',
      access: 'write',
    })) as { id: string };
    await writeFile(
      join(runner.paths.control, 'execution.json'),
      JSON.stringify({
        mode: 'container',
        image: `sha256:${'0'.repeat(64)}`,
        reference: 'fixture',
      }),
    );
    await expect(
      client.request('job.start', { root: root.id, kind: 'command', command: 'test' }),
    ).rejects.toThrow('isolated task tree');
    await expect(client.request('env.inspect', { root: root.id })).rejects.toThrow(
      'cannot validate container',
    );
    const status = (await client.request('status')) as {
      execution: { commands: { strictIsolation: boolean } };
    };
    expect(status.execution.commands.strictIsolation).toBe(true);
  } finally {
    client.close();
    await runner.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
