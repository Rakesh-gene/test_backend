import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { findExecutable } from '@kode/execution';
import { type Workspace, type TaskTree } from './roots.js';
import { loadManifest, type Manifest, type Observer, quiet, runDeclared } from './project.js';
import { atomicJson, hash, inside, json, leased, scoped } from './state.js';

export interface EnvironmentReceipt {
  version: 1;
  rootId: string;
  target: string;
  fingerprint: string;
  state: 'preparing' | 'ready' | 'failed';
  manager: string;
  source: string;
  reason: string;
  preparedAt: string;
  installInvocations: number;
}
const relevant =
  /(^package(-lock)?\.json$|^npm-shrinkwrap\.json$|^\.npmrc$|^global\.json$|^NuGet\.Config$|^nuget\.config$|^Directory\..*\.(props|targets)$|\.(csproj|fsproj|vbproj|sln|slnx)$|^packages\.lock\.json$)/i;
async function inputs(path: string, manifest: Manifest) {
  const files: { path: string; hash: string }[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.kode', 'bin', 'obj'].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (
        entry.isFile() &&
        (relevant.test(entry.name) ||
          manifest.dependencies.inputs.includes(relative(path, absolute).replaceAll('\\', '/')))
      )
        files.push({
          path: relative(path, absolute).replaceAll('\\', '/'),
          hash: hash(await readFile(absolute)),
        });
    }
  };
  await walk(path);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function identity(manager: string, cwd: string) {
  const tool = manager === 'nuget' ? 'dotnet' : 'npm';
  const executable = findExecutable(tool);
  if (!executable) throw new Error(`Missing environment tool: ${tool}.`);
  const result = await execa(executable, ['--version'], {
    cwd,
    reject: false,
    windowsHide: true,
    timeout: 15000,
  });
  if (result.exitCode !== 0) throw new Error(`Cannot determine ${tool} version.`);
  const userConfig =
    manager === 'npm'
      ? (process.env.NPM_CONFIG_USERCONFIG ??
        join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.npmrc'))
      : join(
          process.env.APPDATA ?? join(process.env.HOME ?? '', '.nuget'),
          'NuGet',
          'NuGet.Config',
        );
  const configurationHash = await readFile(userConfig).then(hash, () => 'absent');
  const environmentHash = hash(
    JSON.stringify(
      Object.entries(process.env)
        .filter(([key]) =>
          /^(npm_config_|nuget_|dotnet_|node_options$|cc$|cxx$|cflags$|cxxflags$)/i.test(key),
        )
        .sort(),
    ),
  );
  return {
    tool: result.stdout.trim(),
    node: process.version,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    configurationHash,
    environmentHash,
  };
}
async function hasEscapingLinks(directory: string, boundary: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!inside(boundary, await realpath(path))) return true;
    } else if (entry.isDirectory() && (await hasEscapingLinks(path, boundary))) return true;
  }
  return false;
}
async function containsNative(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.node')) return true;
    if (entry.isDirectory() && (await containsNative(join(directory, entry.name)))) return true;
  }
  return false;
}
export async function healthy(
  path: string,
  manifest: Manifest,
): Promise<{ ok: boolean; reason: string }> {
  const manager = manifest.dependencies.manager;
  if (manager === 'none') return { ok: true, reason: 'No managed dependencies declared.' };
  if (manager === 'npm') {
    const lock = await json<{
      packages?: Record<string, { version?: string; integrity?: string; optional?: boolean }>;
    }>(join(path, 'package-lock.json')).catch(() => undefined);
    if (!lock?.packages)
      return { ok: false, reason: 'package-lock.json with package metadata is required.' };
    const modules = join(path, 'node_modules');
    const modulesPresent = await lstat(modules).then(
      (s) => s.isDirectory() && !s.isSymbolicLink(),
      () => false,
    );
    if (!modulesPresent && Object.keys(lock.packages).some((key) => key.includes('node_modules/')))
      return { ok: false, reason: 'node_modules is missing or is a writable installation link.' };
    if (modulesPresent && (await hasEscapingLinks(modules, path)))
      return { ok: false, reason: 'Installation contains links escaping the target.' };
    if (modulesPresent && (await containsNative(modules)) && !manifest.dependencies.validate)
      return {
        ok: false,
        reason:
          'Native addons require a dependencies.validate command that loads/exercises them under the selected runtime.',
      };
    const installed = await json<{
      packages?: Record<string, { version?: string; integrity?: string }>;
    }>(join(modules, '.package-lock.json')).catch(() => undefined);
    for (const [name, pkg] of Object.entries(lock.packages)) {
      if (!name || !name.includes('node_modules/')) continue;
      if (pkg.optional && !installed?.packages?.[name]) continue;
      if (
        !installed?.packages?.[name] ||
        installed.packages[name]!.version !== pkg.version ||
        installed.packages[name]!.integrity !== pkg.integrity
      )
        return { ok: false, reason: `Installed lock metadata differs: ${name}` };
    }
    const result = await execa(findExecutable('npm')!, ['ls', '--all', '--json', '--offline'], {
      cwd: path,
      reject: false,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: result.exitCode === 0,
      reason:
        result.exitCode === 0
          ? 'Installed lock metadata and npm dependency health agree.'
          : 'npm ls reports missing/invalid dependencies.',
    };
  }
  const projects: string[] =
    manifest.dependencies.projects?.map((project) => scoped(path, project)) ?? [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.kode', 'bin', 'obj'].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.(csproj|fsproj|vbproj)$/i.test(entry.name)) projects.push(absolute);
    }
  };
  if (!manifest.dependencies.projects) await walk(path);
  if (!projects.length) return { ok: false, reason: 'No PackageReference projects found.' };
  for (const project of projects) {
    const canonical = await realpath(project).catch(() => undefined);
    if (!canonical || !inside(path, canonical) || (await lstat(project)).isSymbolicLink())
      return { ok: false, reason: 'Selected project is missing or escapes the target scope.' };
    const text = await readFile(project, 'utf8');
    if (text.includes('packages.config'))
      return {
        ok: false,
        reason: 'packages.config is not supported by the PackageReference adapter.',
      };
    const assets = await json<{
      project?: { restore?: { projectPath?: string; packagesPath?: string } };
      libraries?: Record<string, { type?: string; path?: string }>;
      packageFolders?: Record<string, unknown>;
    }>(join(resolve(project, '..'), 'obj', 'project.assets.json')).catch(() => undefined);
    if (!assets || resolve(assets.project?.restore?.projectPath ?? '') !== project)
      return { ok: false, reason: 'Restore metadata is absent or belongs to another worktree.' };
    const assetsTime = (await lstat(join(resolve(project, '..'), 'obj', 'project.assets.json')))
      .mtimeMs;
    for (const input of await inputs(path, manifest)) {
      if ((await lstat(join(path, input.path))).mtimeMs > assetsTime)
        return {
          ok: false,
          reason: 'Restore metadata predates a project or dependency configuration input.',
        };
    }
    for (const library of Object.values(assets.libraries ?? {})) {
      if (library.type !== 'package') continue;
      const found = await Promise.all(
        Object.keys(assets.packageFolders ?? {}).map((folder) =>
          lstat(join(folder, library.path ?? '', '.nupkg.metadata')).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (!found.some(Boolean))
        return { ok: false, reason: 'A required NuGet package is absent from configured caches.' };
    }
  }
  return {
    ok: true,
    reason: 'Worktree-specific restore metadata and package cache entries exist.',
  };
}
export async function prepareEnvironment(
  workspace: Workspace,
  rootId: string,
  options: {
    treeId?: string;
    offline?: boolean;
    inspect?: boolean;
    signal?: AbortSignal;
    observe?: Observer;
  } = {},
) {
  const root = await workspace.root(rootId);
  const tree: TaskTree | undefined = options.treeId
    ? await workspace.tree(options.treeId)
    : undefined;
  if (tree && tree.rootId !== root.id) throw new Error('Environment tree belongs to another root.');
  const target = tree?.path ?? root.path;
  const manifest = await loadManifest(target);
  const metadata = await inputs(target, manifest);
  const runtime =
    manifest.dependencies.manager === 'none'
      ? {}
      : await identity(manifest.dependencies.manager, target);
  const fingerprint = hash(
    JSON.stringify({
      metadata,
      runtime,
      policy: manifest.dependencies,
      prepare: manifest.dependencies.prepare
        ? manifest.commands[manifest.dependencies.prepare]
        : null,
      validate: manifest.dependencies.validate
        ? manifest.commands[manifest.dependencies.validate]
        : null,
    }),
  );
  const receiptPath = join(workspace.state, 'environments', `${hash(target)}.json`);
  const observe = options.observe ?? quiet;
  const perform = async () => {
    const old = await json<EnvironmentReceipt>(receiptPath).catch(() => undefined);
    if (old?.state === 'preparing' && !options.inspect)
      throw new Error(
        'Interrupted preparation is unready. Preserve this target for inspection and prepare a fresh task tree; unknown orphan installers are not retried in place.',
      );
    let health = await healthy(target, manifest);
    if (
      options.inspect &&
      manifest.dependencies.validate &&
      !(old?.state === 'ready' && old.fingerprint === fingerprint)
    )
      health = {
        ok: false,
        reason: 'Declared validator must run before adopting this environment.',
      };
    if (health.ok && manifest.dependencies.validate && !options.inspect) {
      if (root.access === 'read' || tree?.access === 'read')
        throw new Error('Read-only scope cannot execute an environment validator.');
      const validation = await runDeclared(target, manifest, manifest.dependencies.validate, {
        signal: options.signal,
        observe,
      });
      if (validation.status !== 'passed')
        health = { ok: false, reason: 'Declared environment validation failed.' };
    }
    const compatible = old?.state === 'ready' && old.fingerprint === fingerprint;
    // Existing user installations can be adopted only when health matches the declared lock.
    const reusable =
      manifest.dependencies.manager === 'none' ||
      (manifest.dependencies.reuse === 'auto' && health.ok && (compatible || !old));
    const reason = reusable
      ? health.reason
      : old?.state === 'preparing'
        ? 'Interrupted preparation requires validation/recovery.'
        : old && old.fingerprint !== fingerprint
          ? 'Dependency inputs, runtime/ABI, flags, or configuration changed.'
          : health.reason;
    const receipt: EnvironmentReceipt = {
      version: 1,
      rootId: root.id,
      target,
      fingerprint,
      state: reusable ? 'ready' : 'preparing',
      manager: manifest.dependencies.manager,
      source: reusable ? (compatible ? 'receipt' : 'existing-installation') : 'manager-cache',
      reason,
      preparedAt: new Date().toISOString(),
      installInvocations: 0,
    };
    if (options.inspect) return { ...receipt, healthy: health.ok, needsPreparation: !reusable };
    if (root.access === 'read' || tree?.access === 'read')
      throw new Error('Environment preparation is disabled for read-only roots.');
    if (reusable) {
      if (hash(JSON.stringify(await inputs(target, manifest))) !== hash(JSON.stringify(metadata)))
        throw new Error(
          'Dependency inputs changed during reuse validation; retry with current inputs.',
        );
      await atomicJson(receiptPath, receipt);
      await observe({
        phase: 'environment',
        name: root.name,
        status: 'reused',
        fingerprint,
        source: receipt.source,
        reason,
      });
      return receipt;
    }
    if (!tree)
      throw new Error(
        `User-owned installation needs attention and was preserved: ${reason} Create a task tree before preparation.`,
      );
    if (manifest.dependencies.manager === 'none') receipt.state = 'ready';
    else {
      if (!manifest.dependencies.prepare)
        throw new Error('Declare dependencies.prepare as a named setup command.');
      await atomicJson(receiptPath, receipt); // An interrupted owner never publishes ready.
      await observe({
        phase: 'environment',
        name: root.name,
        status: 'preparing',
        fingerprint,
        source: receipt.source,
        reason,
      });
      const commandName = manifest.dependencies.prepare;
      const configured = manifest.commands[commandName]!;
      const prepared: Manifest = {
        ...manifest,
        commands: {
          ...manifest.commands,
          [commandName]: {
            ...configured,
            run: [...configured.run, ...manifest.dependencies.flags],
          },
        },
      };
      receipt.installInvocations = 1;
      const env: Record<string, string> = options.offline
        ? manifest.dependencies.manager === 'npm'
          ? { npm_config_offline: 'true', npm_config_audit: 'false' }
          : { NuGetAudit: 'false' }
        : {};
      if (options.offline && manifest.dependencies.manager === 'nuget') {
        const locations = await execa(
          findExecutable('dotnet')!,
          ['nuget', 'locals', 'global-packages', '--list'],
          { cwd: target, env: configured.env, windowsHide: true, timeout: 15000 },
        );
        const cache = locations.stdout.replace(/^global-packages:\s*/i, '').trim();
        // Explicit local source prohibits fallback to remote feeds in offline preparation.
        prepared.commands[commandName]!.run.push('--source', cache, '-p:NuGetAudit=false');
      }
      try {
        const result = await runDeclared(target, prepared, commandName, {
          signal: options.signal,
          env,
          observe,
        });
        let after = await healthy(target, manifest);
        if (after.ok && manifest.dependencies.validate) {
          const validation = await runDeclared(target, manifest, manifest.dependencies.validate, {
            signal: options.signal,
            observe,
          });
          if (validation.status !== 'passed')
            after = { ok: false, reason: 'Declared environment validation failed.' };
        }
        if (result.status !== 'passed' || !after.ok)
          throw new Error(
            `Preparation failed${options.offline ? ' offline; required packages may be missing from caches' : ''}: ${after.reason}. ${result.stderr}`,
          );
        if (hash(JSON.stringify(await inputs(target, manifest))) !== hash(JSON.stringify(metadata)))
          throw new Error(
            'Dependency inputs changed during preparation; environment is not ready.',
          );
        receipt.state = 'ready';
      } catch (error) {
        receipt.state = 'failed';
        await atomicJson(receiptPath, receipt);
        throw error;
      }
    }
    await atomicJson(receiptPath, receipt);
    await observe({
      phase: 'environment',
      name: root.name,
      status: 'ready',
      fingerprint,
      source: receipt.source,
      reason,
    });
    return receipt;
  };
  return leased(join(workspace.state, 'environment-locks', `${hash(target)}.lock`), perform);
}
