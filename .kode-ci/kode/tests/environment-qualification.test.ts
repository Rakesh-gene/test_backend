import { test, expect } from 'vitest';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execa } from 'execa';
import { Workspace, prepareEnvironment } from '@kode/workspace';
import { findExecutable } from '@kode/execution';

async function record(name: string, value: unknown) {
  await mkdir('.artifacts', { recursive: true });
  await writeFile(
    `.artifacts/${name}.json`,
    JSON.stringify(
      { passed: true, platform: process.platform, arch: process.arch, value },
      null,
      2,
    ),
  );
}

test('native addon is exercised before reuse; corrupt binaries, selected ABI and external npm configuration cannot reuse a ready receipt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-native-'));
  try {
    const path = join(home, 'repo'),
      modules = join(path, 'node_modules'),
      addon = join(modules, 'native-fixture');
    await mkdir(addon, { recursive: true });
    await cp(resolve('node_modules/better-sqlite3/lib'), join(addon, 'lib'), { recursive: true });
    const binary = resolve('node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    await copyFile(binary, join(addon, 'addon.node'));
    await writeFile(
      join(addon, 'package.json'),
      JSON.stringify({ name: 'native-fixture', version: '1.0.0', main: 'lib/index.js' }),
    );
    const pkg = {
      name: 'native-repo',
      version: '1.0.0',
      dependencies: { 'native-fixture': '1.0.0' },
    };
    const packages = {
      '': pkg,
      'node_modules/native-fixture': { version: '1.0.0', integrity: 'sha512-fixture' },
    };
    await writeFile(join(path, 'package.json'), JSON.stringify(pkg));
    await writeFile(
      join(path, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    await writeFile(
      join(modules, '.package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    const config = join(home, 'selected.npmrc');
    await writeFile(config, 'audit=false\n');
    const manifest = {
      version: 1,
      dependencies: { manager: 'npm', prepare: 'install', validate: 'native-health' },
      commands: {
        install: { run: ['npm', 'ci'], env: { NPM_CONFIG_USERCONFIG: config } },
        'native-health': {
          run: [
            'node',
            '-e',
            "const DB=require('native-fixture');const db=new DB(':memory:',{nativeBinding:require('path').resolve('node_modules/native-fixture/addon.node')});if(db.prepare('select 42 as value').get().value!==42)process.exit(2);db.close();console.log('NATIVE_SQLITE_OK')",
          ],
          env: {} as Record<string, string>,
        },
      },
    };
    const save = () => writeFile(join(path, 'kode.yaml'), JSON.stringify(manifest));
    await save();
    const workspace = new Workspace(home);
    await workspace.init();
    const root = await workspace.add(path, 'native', 'write');
    const healthy = await prepareEnvironment(workspace, root.id);
    expect(healthy.state).toBe('ready');
    expect(healthy.installInvocations).toBe(0);
    expect((await prepareEnvironment(workspace, root.id)).source).toBe('receipt');
    const originalLock = await readFile(join(path, 'package-lock.json'));
    await writeFile(join(addon, 'addon.node'), 'invalid native binary');
    await expect(prepareEnvironment(workspace, root.id)).rejects.toThrow('validation failed');
    expect(await readFile(join(addon, 'addon.node'), 'utf8')).toBe('invalid native binary');
    await copyFile(binary, join(addon, 'addon.node'));
    await writeFile(config, 'audit=false\nlegacy-peer-deps=true\n');
    await expect(prepareEnvironment(workspace, root.id)).rejects.toThrow('configuration changed');
    await writeFile(config, 'audit=false\n');
    expect((await prepareEnvironment(workspace, root.id)).source).toBe('receipt');
    // A real second runtime is supplied by native CI; the host nvm selection stays unchanged.
    let abi: string = 'not supplied';
    if (process.env.KODE_ALT_NODE_DIR) {
      manifest.commands['native-health'].env.PATH =
        `${process.env.KODE_ALT_NODE_DIR}${delimiter}${process.env.PATH}`;
      await save();
      await expect(prepareEnvironment(workspace, root.id)).rejects.toThrow('preserved');
      const check = await execa(
        join(process.env.KODE_ALT_NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node'),
        ['-p', 'process.versions.modules'],
      );
      expect(check.stdout).not.toBe(process.versions.modules);
      const load = await execa(
        join(process.env.KODE_ALT_NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node'),
        manifest.commands['native-health'].run.slice(1),
        { cwd: path, reject: false, windowsHide: true },
      );
      expect(load.exitCode).not.toBe(0);
      expect(load.stderr).toContain('NODE_MODULE_VERSION');
      abi = check.stdout;
    }
    expect(await readFile(join(path, 'package-lock.json'))).toEqual(originalLock);
    await record('GAP-008-native', {
      healthy,
      realSqliteQuery: true,
      corruptBinaryRejected: true,
      externalConfigInvalidated: true,
      sourcePreserved: true,
      harnessAbi: process.versions.modules,
      alternateAbi: abi,
    });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60000);

test('NuGet ancestor configuration invalidates reuse and unavailable SDK selection fails before dispatch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kode-sdk-'));
  try {
    const path = join(home, 'repo');
    await mkdir(path);
    const config = join(home, 'NuGet.Config');
    await writeFile(
      config,
      '<configuration><packageSources><clear /></packageSources></configuration>',
    );
    const dotnet = findExecutable('dotnet')!;
    const sdk = (
      await execa(dotnet, ['--version'], { cwd: path, windowsHide: true })
    ).stdout.trim();
    await writeFile(
      join(path, 'global.json'),
      JSON.stringify({ sdk: { version: sdk, rollForward: 'disable' } }),
    );
    await writeFile(
      join(path, 'app.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>',
    );
    await writeFile(
      join(path, 'kode.yaml'),
      JSON.stringify({
        version: 1,
        dependencies: { manager: 'nuget', prepare: 'restore' },
        commands: { restore: { run: ['dotnet', 'restore', '--configfile', config] } },
      }),
    );
    await execa(dotnet, ['restore', '--configfile', config], {
      cwd: path,
      windowsHide: true,
      timeout: 30000,
    });
    const workspace = new Workspace(home);
    await workspace.init();
    const root = await workspace.add(path, 'sdk', 'write');
    const ready = await prepareEnvironment(workspace, root.id);
    expect(ready.installInvocations).toBe(0);
    await writeFile(
      config,
      '<configuration><packageSources><clear /></packageSources><!--changed--></configuration>',
    );
    await expect(prepareEnvironment(workspace, root.id)).rejects.toThrow('preserved');
    const available = (await execa(dotnet, ['--list-sdks'], { windowsHide: true })).stdout
      .split(/\r?\n/)
      .map((line) => line.split(' ')[0]!)
      .find((version) => version && version !== sdk);
    if (process.env.KODE_REQUIRE_ALT_SDK === '1') expect(available).toBeTruthy();
    if (available) {
      await writeFile(
        join(path, 'global.json'),
        JSON.stringify({ sdk: { version: available, rollForward: 'disable' } }),
      );
      expect(
        (await execa(dotnet, ['--version'], { cwd: path, windowsHide: true })).stdout.trim(),
      ).toBe(available);
      const changed = await prepareEnvironment(workspace, root.id, { inspect: true });
      expect(changed.needsPreparation).toBe(true);
      expect(changed.fingerprint).not.toBe(ready.fingerprint);
    }
    await writeFile(
      join(path, 'global.json'),
      JSON.stringify({ sdk: { version: '99.0.100', rollForward: 'disable' } }),
    );
    await expect(prepareEnvironment(workspace, root.id)).rejects.toThrow(
      'Cannot determine dotnet version',
    );
    await record('GAP-008-sdk', {
      selectedSdk: sdk,
      alternateSdk: available ?? 'not installed',
      ancestorAndExplicitConfigInvalidated: true,
      unavailableSdkRejectedBeforeDispatch: true,
      sourcePreserved: true,
    });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60000);
