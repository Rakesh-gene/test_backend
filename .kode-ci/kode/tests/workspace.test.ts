import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import {
  Workspace,
  RepoManifest,
  prepareEnvironment,
  runDeclared,
  runWithServices,
  atomicJson,
  type Activity,
} from '@kode/workspace';
import { findExecutable } from '@kode/execution';
import { RunnerClient, startRunner } from '@kode/runner';

const directories: string[] = [];
async function evidence(name: string, value: unknown) {
  await mkdir('.artifacts', { recursive: true });
  await writeFile(
    join('.artifacts', name),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        value,
      },
      null,
      2,
    ),
  );
}
const git = (cwd: string, args: string[]) =>
  execa('git', ['-C', cwd, ...args], { windowsHide: true });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'kode-workspace-'));
  directories.push(path);
  return path;
}
async function repo(parent: string, name = 'api space ü') {
  const path = join(parent, name);
  await mkdir(path);
  await git(path, ['init']);
  await git(path, ['config', 'user.name', 'Kode Fixture']);
  await git(path, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(path, 'file.txt'), 'committed\n');
  await writeFile(join(path, 'deleted.txt'), 'delete me');
  await git(path, ['add', '.']);
  await git(path, ['commit', '-m', 'fixture']);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe('P02 multi-root dirty-baseline isolation', () => {
  test('canonical roots, nested boundaries, read-only scope, unregister and retained cleanup', async () => {
    const home = await directory(),
      workspace = new Workspace(home);
    await workspace.init();
    const backend = await repo(home),
      frontend = await repo(home, 'web');
    const docs = join(home, 'reference');
    await mkdir(docs);
    await writeFile(join(docs, 'guide.md'), 'guide');
    const api = await workspace.add(backend, 'api', 'write');
    await workspace.add(frontend, 'web', 'write');
    const reference = await workspace.add(docs, 'docs', 'read');
    expect((await workspace.list()).roots).toHaveLength(3);
    await expect(workspace.add(backend, 'alias', 'write')).rejects.toThrow('Duplicate');
    const alias = join(home, 'alias');
    await symlink(backend, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasedWorkspace = new Workspace(alias);
    expect(aliasedWorkspace.path).toBe(api.path);
    expect(aliasedWorkspace.state).toBe(join(api.path, '.kode'));
    await expect(workspace.add(alias, 'alias', 'write')).rejects.toThrow('Duplicate');
    if (process.platform === 'win32')
      await expect(workspace.add(backend.toUpperCase(), 'case', 'write')).rejects.toThrow(
        'Duplicate',
      );
    await mkdir(join(backend, 'src'));
    await expect(workspace.add(join(backend, 'src'), 'subdir', 'write')).rejects.toThrow(
      'boundary',
    );
    const nested = await repo(backend, 'nested');
    expect((await workspace.add(nested, 'nested', 'write')).kind).toBe('git');
    await expect(workspace.createTree(reference.id)).rejects.toThrow('Read-only');
    const tree = await workspace.createTree(reference.id, undefined, 'read');
    expect(tree.mode).toBe('snapshot');
    expect(await readFile(join(tree.path, 'guide.md'), 'utf8')).toBe('guide');
    await workspace.retain(tree.id);
    await expect(workspace.cleanup(tree.id)).rejects.toThrow('retained');
    await workspace.remove(api.id);
    expect(await readFile(join(backend, 'file.txt'), 'utf8')).toBe('committed\n');
  });
  test('staged plus unstaged bytes, untracked additions and deletion survive in independent worktrees', async () => {
    const home = await directory(),
      workspace = new Workspace(home);
    await workspace.init();
    const path = await repo(home),
      root = await workspace.add(path, 'api', 'write');
    await writeFile(join(path, 'file.txt'), 'staged\n');
    await git(path, ['add', 'file.txt']);
    await writeFile(join(path, 'file.txt'), 'unstaged current\n');
    await writeFile(join(path, 'untracked ü.txt'), 'local\0bytes');
    await rm(join(path, 'deleted.txt'));
    const hookMarker = join(home, 'hook-ran');
    const hookPath = join(path, '.git', 'hooks', 'post-checkout');
    await writeFile(
      hookPath,
      `#!/bin/sh\nprintf called > '${hookMarker.replaceAll('\\', '/').replaceAll("'", "'\\''")}'\n`,
    );
    await chmod(hookPath, 0o755);
    const before = {
      status: (await git(path, ['status', '--porcelain=v1', '-z'])).stdout,
      index: (await git(path, ['ls-files', '--stage', '-z'])).stdout,
      head: (await git(path, ['rev-parse', 'HEAD'])).stdout,
    };
    const baseline = await workspace.capture(root.id);
    expect(baseline.status).toContain('MM file.txt');
    const one = await workspace.createTree(root.id, baseline.id),
      two = await workspace.createTree(root.id, baseline.id);
    expect(await readFile(hookMarker, 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(join(one.path, 'file.txt'), 'utf8')).toBe('unstaged current\n');
    expect(await readFile(join(one.path, 'untracked ü.txt'))).toEqual(
      await readFile(join(path, 'untracked ü.txt')),
    );
    expect(await readdir(one.path)).not.toContain('deleted.txt');
    await writeFile(join(one.path, 'file.txt'), 'agent one');
    expect(await readFile(join(two.path, 'file.txt'), 'utf8')).toBe('unstaged current\n');
    expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('unstaged current\n');
    expect((await git(path, ['status', '--porcelain=v1', '-z'])).stdout).toBe(before.status);
    expect((await git(path, ['ls-files', '--stage', '-z'])).stdout).toBe(before.index);
    expect((await git(path, ['rev-parse', 'HEAD'])).stdout).toBe(before.head);
    await evidence('P02-baseline.json', {
      baseline,
      before,
      after: {
        status: (await git(path, ['status', '--porcelain=v1', '-z'])).stdout,
        index: (await git(path, ['ls-files', '--stage', '-z'])).stdout,
        head: (await git(path, ['rev-parse', 'HEAD'])).stdout,
      },
      one,
      two,
      sourceContent: await readFile(join(path, 'file.txt'), 'utf8'),
      independentContent: await readFile(join(two.path, 'file.txt'), 'utf8'),
    });
    await mkdir(join(workspace.state, 'tree-locks'), { recursive: true });
    const useLease = join(workspace.state, 'tree-locks', `${one.id}.lock`);
    await writeFile(useLease, JSON.stringify({ pid: process.pid }));
    await expect(workspace.cleanup(one.id)).rejects.toThrow('leased');
    expect(await readFile(join(one.path, 'file.txt'), 'utf8')).toBe('agent one');
    await rm(useLease);
    await atomicJson(join(workspace.state, 'baselines', `${baseline.id}.json`), {
      ...baseline,
      head: 'corrupt-input',
    });
    await expect(workspace.createTree(root.id, baseline.id)).rejects.toThrow('integrity');
    await workspace.cleanup(one.id);
    await workspace.cleanup(two.id);
    expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('unstaged current\n');
  });
  test('capture retries racing changes, blocks unstable captures, supports unborn/detached states', async () => {
    const home = await directory(),
      workspace = new Workspace(home);
    await workspace.init();
    const path = await repo(home),
      root = await workspace.add(path, 'api', 'write');
    let scans = 0;
    await workspace.capture(root.id, async () => {
      if (scans++ === 0) await writeFile(join(path, 'file.txt'), 'racing');
    });
    expect(scans).toBe(2);
    await expect(
      workspace.capture(root.id, async () => {
        await writeFile(join(path, 'file.txt'), String(scans++));
      }),
    ).rejects.toThrow('three');
    await git(path, ['checkout', '--detach']);
    expect((await workspace.capture(root.id)).branch).toBeNull();
    const unborn = join(home, 'unborn');
    await mkdir(unborn);
    await git(unborn, ['init']);
    await writeFile(join(unborn, 'new.txt'), 'uncommitted');
    const fresh = await workspace.add(unborn, 'fresh', 'write');
    expect((await workspace.createTree(fresh.id)).mode).toBe('snapshot');
  });
});

describe('P03 repository contracts, command boundaries and lifecycle', () => {
  test('schema references and escaped cwd fail; arguments are literal; output credentials are redacted', async () => {
    const path = await directory();
    expect(
      RepoManifest.safeParse({ version: 1, commands: { bad: { run: ['node'], cwd: '../escape' } } })
        .success,
    ).toBe(false);
    expect(
      RepoManifest.safeParse({
        version: 1,
        commands: {},
        dependencies: { manager: 'npm', prepare: 'missing' },
      }).success,
    ).toBe(false);
    const literal = 'space ü & echo owned; $(whoami)';
    const manifest = RepoManifest.parse({
      version: 1,
      commands: {
        echo: {
          run: [
            'node',
            '-e',
            'process.stdout.write(JSON.stringify({arg:process.argv[1],cwd:process.cwd(),secret:process.env.API_KEY}))',
            literal,
          ],
          env: { API_KEY: 'fixture-private-value' },
        },
        missing: { run: ['kode-nonexistent-tool-1'] },
      },
    });
    const result = await runDeclared(path, manifest, 'echo');
    expect(result.status).toBe('passed');
    expect(result.stdout).toContain(literal);
    expect(result.stdout).toContain(path.replaceAll('\\', '\\\\'));
    expect(result.stdout).not.toContain('fixture-private-value');
    expect(result.stdout).toContain('[REDACTED]');
    await expect(runDeclared(path, manifest, 'missing')).rejects.toThrow('Missing tool');
    await expect(runDeclared(path, manifest, 'unknown')).rejects.toThrow('Unknown command');
  });
  test('timeouts and cancellation stop owned commands while unrelated processes remain alive', async () => {
    const path = await directory();
    const manifest = RepoManifest.parse({
      version: 1,
      commands: {
        wait: { run: ['node', '-e', 'setInterval(()=>{},1000)'], timeout_seconds: 0.4 },
        long: { run: ['node', '-e', 'setInterval(()=>{},1000)'], timeout_seconds: 10 },
      },
    });
    const unrelated = execa(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      reject: false,
      windowsHide: true,
    });
    try {
      expect((await runDeclared(path, manifest, 'wait')).status).toBe('timed_out');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 200);
      try {
        expect(
          (await runDeclared(path, manifest, 'long', { signal: controller.signal })).status,
        ).toBe('cancelled');
      } finally {
        clearTimeout(timer);
      }
      process.kill(unrelated.pid!, 0);
    } finally {
      unrelated.kill();
      await unrelated;
    }
  });
  test('cancellation terminates an owned grandchild process', async () => {
    const path = await directory();
    const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000);`;
    const manifest = RepoManifest.parse({
      version: 1,
      commands: { tree: { run: ['node', '-e', script], timeout_seconds: 10 } },
    });
    const controller = new AbortController();
    const pending = runDeclared(path, manifest, 'tree', { signal: controller.signal });
    let pid = 0;
    const deadline = Date.now() + 5000;
    while (!pid && Date.now() < deadline) {
      pid = Number(await readFile(join(path, 'child.pid'), 'utf8').catch(() => '0'));
      if (!pid) await new Promise((r) => setTimeout(r, 50));
    }
    controller.abort();
    expect((await pending).status).toBe('cancelled');
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive).toBe(false);
  });
  test('dependency-ordered services allocate ports, await readiness, and run cleanup', async () => {
    const path = await directory();
    const server =
      "require('node:http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')";
    const manifest = RepoManifest.parse({
      version: 1,
      commands: {
        serve: { run: ['node', '-e', server] },
        setup: { run: ['node', '-e', "require('fs').writeFileSync('setup.txt','ready')"] },
        cleanup: { run: ['node', '-e', "require('fs').writeFileSync('cleanup.txt','done')"] },
        check: {
          run: [
            'node',
            '-e',
            "fetch(process.argv[1]).then(async r=>{if(await r.text()!=='ok')process.exit(1)})",
            'http://127.0.0.1:${port:web}',
          ],
          services: ['web'],
        },
      },
      services: {
        db: {
          command: 'serve',
          readiness: { http: 'http://127.0.0.1:${port:db}', timeout_seconds: 5 },
        },
        web: {
          command: 'serve',
          depends_on: ['db'],
          setup: 'setup',
          cleanup: 'cleanup',
          readiness: { http: 'http://127.0.0.1:${port:web}', timeout_seconds: 5 },
        },
      },
    });
    const events: Activity[] = [];
    expect(
      (
        await runWithServices(path, manifest, 'check', {
          observe: async (event) => {
            events.push(event);
          },
        })
      ).status,
    ).toBe('passed');
    expect(
      events
        .filter((event) => event.phase === 'service' && event.status === 'ready')
        .map((event) => event.name),
    ).toEqual(['db', 'web']);
    expect(events.filter((event) => event.status === 'stopped').map((event) => event.name)).toEqual(
      ['web', 'db'],
    );
    expect(await readFile(join(path, 'cleanup.txt'), 'utf8')).toBe('done');
    const controller = new AbortController();
    const cancelled = RepoManifest.parse({
      ...manifest,
      commands: {
        ...manifest.commands,
        check: { ...manifest.commands.check, run: ['node', '-e', 'setInterval(()=>{},1000)'] },
      },
    });
    const stopped = await runWithServices(path, cancelled, 'check', {
      signal: controller.signal,
      observe: async (event) => {
        if (event.phase === 'command' && event.name === 'check' && event.status === 'running')
          setTimeout(() => controller.abort(), 100);
      },
    });
    expect(stopped.status).toBe('cancelled');
  });
  test('port collisions preserve existing listeners; timeout and failed setup still clean up', async () => {
    const path = await directory();
    const listener = createServer();
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
    const port = (listener.address() as { port: number }).port;
    const base = {
      version: 1,
      commands: {
        serve: { run: ['node', '-e', 'setInterval(()=>{},1000)'] },
        fail: { run: ['node', '-e', 'process.exit(1)'] },
        cleanup: { run: ['node', '-e', "require('fs').writeFileSync('cleanup','done')"] },
        check: { run: ['node', '-e', ''], services: ['web'] },
      },
      services: {
        web: {
          command: 'serve',
          port,
          readiness: { http: `http://127.0.0.1:${port}`, timeout_seconds: 0.3 },
        },
      },
    };
    try {
      await expect(runWithServices(path, RepoManifest.parse(base), 'check')).rejects.toThrow(
        'collision',
      );
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => listener.close(() => r()));
    }
    const timeout = RepoManifest.parse({
      ...base,
      services: {
        web: {
          ...base.services.web,
          port: 'auto',
          readiness: { http: 'http://127.0.0.1:${port:web}', timeout_seconds: 0.3 },
        },
      },
    });
    await expect(runWithServices(path, timeout, 'check')).rejects.toThrow('readiness');
    const fail = RepoManifest.parse({
      ...base,
      services: { web: { ...base.services.web, port: 'auto', setup: 'fail', cleanup: 'cleanup' } },
    });
    await expect(runWithServices(path, fail, 'check')).rejects.toThrow('Fixture setup');
    expect(await readFile(join(path, 'cleanup'), 'utf8')).toBe('done');
  });
});

describe('P03 manager reuse and durable runner integration', () => {
  test('healthy npm reuse, concurrent isolated offline preparation and invalidation preserve source', async () => {
    const home = await directory(),
      workspace = new Workspace(home);
    await workspace.init();
    const path = join(home, 'npm');
    await mkdir(path);
    const npm = findExecutable('npm')!;
    const packageSource = join(home, 'package-source'),
      cache = join(home, 'cache');
    await mkdir(packageSource);
    await writeFile(
      join(packageSource, 'package.json'),
      JSON.stringify({ name: 'kode-cache-fixture', version: '1.0.0', main: 'index.js' }),
    );
    await writeFile(join(packageSource, 'index.js'), 'module.exports = 42;');
    await execa(npm, ['pack', '--ignore-scripts', '--offline', '--cache', cache], {
      cwd: packageSource,
      windowsHide: true,
      timeout: 30000,
    });
    const tarball = join(packageSource, 'kode-cache-fixture-1.0.0.tgz');
    const integrity = `sha512-${createHash('sha512')
      .update(await readFile(tarball))
      .digest('base64')}`;
    await execa(npm, ['cache', 'add', tarball, '--cache', cache, '--offline'], {
      cwd: home,
      windowsHide: true,
      timeout: 30000,
    });
    const pkg = {
      name: 'fixture',
      version: '1.0.0',
      private: true,
      dependencies: { 'kode-cache-fixture': '1.0.0' },
    };
    await writeFile(join(path, 'package.json'), JSON.stringify(pkg));
    await writeFile(
      join(path, 'package-lock.json'),
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': pkg,
          'node_modules/kode-cache-fixture': {
            version: '1.0.0',
            resolved: 'https://packages.invalid/kode-cache-fixture-1.0.0.tgz',
            integrity,
          },
        },
      }),
    );
    await execa(
      npm,
      ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache],
      { cwd: path, windowsHide: true, timeout: 30000 },
    );
    await writeFile(
      join(path, 'kode.yaml'),
      JSON.stringify({
        version: 1,
        dependencies: { manager: 'npm', prepare: 'install' },
        commands: {
          install: {
            run: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache],
          },
        },
      }),
    );
    const root = await workspace.add(path, 'node', 'write');
    const original = await readFile(join(path, 'package-lock.json'));
    const reused = await prepareEnvironment(workspace, root.id);
    expect(reused.source).toBe('existing-installation');
    expect(reused.installInvocations).toBe(0);
    expect((await prepareEnvironment(workspace, root.id)).installInvocations).toBe(0);
    const tree = await workspace.createTree(root.id);
    const receipts = await Promise.all(
      [1, 2].map(() => prepareEnvironment(workspace, root.id, { treeId: tree.id, offline: true })),
    );
    expect(receipts.reduce((sum, item) => sum + item.installInvocations, 0)).toBe(1);
    expect(receipts.every((item) => item.state === 'ready')).toBe(true);
    await evidence('P03-npm-reuse.json', {
      reused,
      concurrent: receipts,
      integrity,
      packageLoaded: (
        await execa(process.execPath, ['-e', "console.log(require('kode-cache-fixture'))"], {
          cwd: tree.path,
          windowsHide: true,
        })
      ).stdout,
    });
    await writeFile(join(path, '.npmrc'), 'legacy-peer-deps=true\n');
    await expect(prepareEnvironment(workspace, root.id)).rejects.toThrow('preserved');
    expect(await readFile(join(path, 'package-lock.json'))).toEqual(original);
    // An interrupted receipt is not reusable even if files happen to look healthy.
    const files = await readdir(join(workspace.state, 'environments'));
    for (const file of files) {
      const receiptPath = join(workspace.state, 'environments', file);
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      if (receipt.target === tree.path)
        await atomicJson(receiptPath, { ...receipt, state: 'preparing' });
    }
    expect(
      (await prepareEnvironment(workspace, root.id, { treeId: tree.id, inspect: true }))
        .needsPreparation,
    ).toBe(true);
    const cold = await workspace.createTree(root.id);
    const coldManifest = JSON.parse(await readFile(join(cold.path, 'kode.yaml'), 'utf8'));
    coldManifest.commands.install.run = [
      'npm',
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(home, 'empty-cache'),
    ];
    await writeFile(join(cold.path, 'kode.yaml'), JSON.stringify(coldManifest));
    await expect(
      prepareEnvironment(workspace, root.id, { treeId: cold.id, offline: true }),
    ).rejects.toThrow('offline');
  }, 120000);
  test('NuGet cache reuse retains independent restore metadata and runs real .NET code', async () => {
    const home = await directory(),
      workspace = new Workspace(home);
    await workspace.init();
    const path = join(home, 'dotnet');
    await mkdir(path);
    const env = {
      DOTNET_CLI_HOME: join(home, 'dotnet-home'),
      DOTNET_NOLOGO: 'true',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      NUGET_PACKAGES: join(home, 'nuget-cache'),
    };
    const feed = join(home, 'empty-feed');
    await mkdir(feed);
    const library = join(home, 'library');
    await mkdir(library);
    await writeFile(
      join(library, 'Library.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><PackageId>Kode.CacheFixture</PackageId><Version>1.0.0</Version><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>',
    );
    await writeFile(
      join(library, 'Value.cs'),
      'namespace KodeFixture; public static class Value { public static int Number => 42; }',
    );
    await execa(findExecutable('dotnet')!, ['restore', '--source', feed, '-p:NuGetAudit=false'], {
      cwd: library,
      env,
      windowsHide: true,
      timeout: 30000,
    });
    await execa(findExecutable('dotnet')!, ['pack', '--no-restore', '--output', feed], {
      cwd: library,
      env,
      windowsHide: true,
      timeout: 30000,
    });
    await writeFile(
      join(path, 'Fixture.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><NuGetAudit>false</NuGetAudit></PropertyGroup><ItemGroup><PackageReference Include="Kode.CacheFixture" Version="1.0.0" /></ItemGroup></Project>',
    );
    await writeFile(
      join(path, 'Program.cs'),
      'System.Console.WriteLine(KodeFixture.Value.Number == 42 ? "KODE_DOTNET_READY" : "FAIL");',
    );
    await writeFile(
      join(path, 'kode.yaml'),
      JSON.stringify({
        version: 1,
        dependencies: { manager: 'nuget', prepare: 'restore', projects: ['Fixture.csproj'] },
        commands: {
          restore: { run: ['dotnet', 'restore', '-p:NuGetAudit=false'], env },
          check: { run: ['dotnet', 'run', '--no-restore'], env },
        },
      }),
    );
    const unused = join(path, 'unused');
    await mkdir(unused);
    await writeFile(
      join(unused, 'Unused.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    );
    await execa(findExecutable('dotnet')!, ['restore', '--source', feed, '-p:NuGetAudit=false'], {
      cwd: path,
      env,
      windowsHide: true,
      timeout: 30000,
    });
    const root = await workspace.add(path, 'net', 'write');
    expect((await prepareEnvironment(workspace, root.id)).installInvocations).toBe(0);
    const tree = await workspace.createTree(root.id);
    expect(
      (await prepareEnvironment(workspace, root.id, { treeId: tree.id, offline: true })).state,
    ).toBe('ready');
    const sourceAssets = JSON.parse(
      await readFile(join(path, 'obj', 'project.assets.json'), 'utf8'),
    );
    const treeAssets = JSON.parse(
      await readFile(join(tree.path, 'obj', 'project.assets.json'), 'utf8'),
    );
    expect(sourceAssets.project.restore.projectPath).not.toBe(
      treeAssets.project.restore.projectPath,
    );
    expect(Object.keys(sourceAssets.packageFolders)).toEqual(
      Object.keys(treeAssets.packageFolders),
    );
    const result = await runDeclared(
      tree.path,
      RepoManifest.parse(JSON.parse(await readFile(join(tree.path, 'kode.yaml'), 'utf8'))),
      'check',
    );
    expect(result.status).toBe('passed');
    expect(result.stdout).toContain('KODE_DOTNET_READY');
    await evidence('P03-nuget-reuse.json', {
      sourceProject: sourceAssets.project.restore.projectPath,
      targetProject: treeAssets.project.restore.projectPath,
      cacheFolders: Object.keys(treeAssets.packageFolders),
      packages: Object.keys(treeAssets.libraries),
      command: result,
    });
  }, 60000);
  test('runner exposes registration/jobs, blocks read-only execution and supports detached cancellation', async () => {
    const home = await directory(),
      runner = await startRunner(home);
    const client = await RunnerClient.connect(runner.paths);
    try {
      const path = join(home, 'ordinary');
      await mkdir(path);
      await writeFile(
        join(path, 'kode.yaml'),
        'version: 1\ncommands:\n  wait:\n    run: [node, -e, "setInterval(()=>{},1000)"]\n',
      );
      await client.request('folder.add', { path, name: 'read', access: 'read' });
      await expect(
        client.request('job.start', { root: 'read', kind: 'command', command: 'wait' }),
      ).rejects.toThrow('Read-only');
      await client.request('folder.remove', { root: 'read' });
      await client.request('folder.add', { path, name: 'write', access: 'write' });
      const job = (await client.request('job.start', {
        root: 'write',
        kind: 'command',
        command: 'wait',
      })) as { id: string };
      expect(await client.request('ping')).toMatchObject({ pong: true });
      await new Promise((r) => setTimeout(r, 200));
      await client.request('job.cancel', { id: job.id });
      let result: { status: string };
      do {
        await new Promise((r) => setTimeout(r, 100));
        result = (await client.request('job.get', { id: job.id })) as typeof result;
      } while (result.status === 'running');
      expect(result.status).toBe('cancelled');
      expect(await client.request('events.list')).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'tool.updated' })]),
      );
    } finally {
      client.close();
      await runner.close();
    }
  });
  test('a killed preparation owner leaves an unready receipt and blocks an unsafe in-place retry', async () => {
    const home = await directory(),
      workspace = new Workspace(home);
    await workspace.init();
    const path = join(home, 'partial');
    await mkdir(path);
    await writeFile(
      join(path, 'package.json'),
      JSON.stringify({ name: 'partial', version: '1.0.0', dependencies: { missing: '1.0.0' } }),
    );
    await writeFile(
      join(path, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { name: 'partial' }, 'node_modules/missing': { version: '1.0.0' } },
      }),
    );
    await writeFile(
      join(path, 'kode.yaml'),
      JSON.stringify({
        version: 1,
        dependencies: { manager: 'npm', prepare: 'install' },
        commands: {
          install: {
            run: [
              'node',
              '-e',
              "require('fs').writeFileSync('installer.pid',String(process.pid));setInterval(()=>{},1000)",
            ],
          },
        },
      }),
    );
    const root = await workspace.add(path, 'partial', 'write'),
      tree = await workspace.createTree(root.id);
    const script =
      "import {Workspace,prepareEnvironment} from '@kode/workspace';await prepareEnvironment(new Workspace(process.argv[1]),'partial',{treeId:process.argv[2]});";
    const owner = execa(process.execPath, ['--input-type=module', '-e', script, home, tree.id], {
      reject: false,
      windowsHide: true,
      timeout: 15000,
    });
    let installer = 0;
    const deadline = Date.now() + 10000;
    while (!installer && Date.now() < deadline) {
      installer = Number(await readFile(join(tree.path, 'installer.pid'), 'utf8').catch(() => '0'));
      if (!installer) await new Promise((r) => setTimeout(r, 50));
    }
    try {
      expect(installer).toBeGreaterThan(0);
      owner.kill('SIGKILL');
      await owner;
      const state = await prepareEnvironment(workspace, root.id, {
        treeId: tree.id,
        inspect: true,
      });
      expect(state.state).toBe('preparing');
      expect(state.needsPreparation).toBe(true);
      await expect(prepareEnvironment(workspace, root.id, { treeId: tree.id })).rejects.toThrow(
        'Interrupted preparation',
      );
      await evidence('P03-interrupted-preparation.json', {
        state,
        inPlaceRetry: 'blocked',
        recovery: 'inspect orphan process; prepare a fresh isolated tree',
      });
    } finally {
      owner.kill('SIGKILL');
      await owner;
      if (installer > 0) {
        if (process.platform === 'win32')
          await execa('taskkill', ['/pid', String(installer), '/T', '/F'], {
            reject: false,
            windowsHide: true,
          });
        else {
          try {
            process.kill(installer, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
      }
    }
  }, 30000);
});
