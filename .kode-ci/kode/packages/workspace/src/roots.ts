import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { atomicJson, hash, inside, json, leased, scoped } from './state.js';

export interface Root {
  id: string;
  name: string;
  path: string;
  access: 'read' | 'write';
  kind: 'git' | 'folder';
}
export interface Registry {
  version: 1;
  roots: Root[];
}
export interface FileEntry {
  path: string;
  hash: string;
  executable: boolean;
}
export interface Baseline {
  version: 1;
  id: string;
  rootId: string;
  head: string | null;
  branch: string | null;
  status: string;
  indexHash: string;
  indexEntries: string;
  files: FileEntry[];
  digest: string;
  capturedAt: string;
}
export interface TaskTree {
  version: 1;
  id: string;
  rootId: string;
  baseline: string;
  path: string;
  source: string;
  mode: 'worktree' | 'snapshot';
  access: 'read' | 'write';
  retained: boolean;
}
const omitted = new Set([
  '.git',
  '.kode',
  '.tools',
  '.artifacts',
  'node_modules',
  'bin',
  'obj',
  '.vs',
]);
const RootSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    path: z.string().min(1),
    access: z.enum(['read', 'write']),
    kind: z.enum(['git', 'folder']),
  })
  .strict();
const RegistrySchema = z
  .object({ version: z.literal(1), roots: z.array(RootSchema).max(100) })
  .strict();
const TreeSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    rootId: z.string().uuid(),
    baseline: z.string().uuid(),
    path: z.string().min(1),
    source: z.string().min(1),
    mode: z.enum(['worktree', 'snapshot']),
    access: z.enum(['read', 'write']),
    retained: z.boolean(),
  })
  .strict();
const BaselineSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    rootId: z.string().uuid(),
    head: z.string().nullable(),
    branch: z.string().nullable(),
    status: z.string(),
    indexHash: z.string(),
    indexEntries: z.string(),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          executable: z.boolean(),
        })
        .strict(),
    ),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    capturedAt: z.string(),
  })
  .strict();
const git = (cwd: string, args: string[]) =>
  execa('git', ['-C', cwd, ...args], {
    reject: false,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
async function requiredGit(cwd: string, args: string[]) {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
export class Workspace {
  readonly state: string;
  constructor(readonly path: string) {
    // Resolve macOS /var aliases and Windows 8.3 names through the same native
    // filesystem semantics as async realpath before constructing owned paths.
    this.path = realpathSync.native(path);
    this.state = join(this.path, '.kode');
  }
  async init() {
    const canonical = await realpath(this.path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace must be a directory.');
    await mkdir(this.state, { recursive: true, mode: 0o700 });
    if ((await lstat(this.state)).isSymbolicLink())
      throw new Error('Workspace state must not be a symlink.');
    return leased(join(this.state, 'registry.lock'), async () => {
      const registry = await this.list();
      await atomicJson(join(this.state, 'workspace.json'), registry);
      return registry;
    });
  }
  async list(): Promise<Registry> {
    try {
      return RegistrySchema.parse(await json<Registry>(join(this.state, 'workspace.json')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, roots: [] };
      throw new Error('Invalid workspace registry; preserve it and repair before continuing.', {
        cause: error,
      });
    }
  }
  async root(id: string) {
    const root = (await this.list()).roots.find((item) => item.id === id || item.name === id);
    if (!root) throw new Error(`Unknown root: ${id}. Use folder list.`);
    if ((await realpath(root.path)) !== root.path)
      throw new Error('Registered root identity changed.');
    return root;
  }
  async add(path: string, name: string, access: Root['access']) {
    if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(name))
      throw new Error('Root name must be 1–80 letters, numbers, dots, underscores or hyphens.');
    const canonical = await realpath(resolve(this.path, path));
    if (!(await stat(canonical)).isDirectory()) throw new Error('Root must be a directory.');
    const discovery = await git(canonical, ['rev-parse', '--show-toplevel']);
    let kind: Root['kind'] = 'folder';
    if (discovery.exitCode === 0) {
      const top = await realpath(discovery.stdout.trim());
      if (top !== canonical)
        throw new Error(`Register repository boundary ${top}; a subfolder is ambiguous.`);
      kind = 'git';
    }
    return leased(join(this.state, 'registry.lock'), async () => {
      const registry = await this.list();
      const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
      if (
        registry.roots.some(
          (root) => key(root.path) === key(canonical) || root.name === name || root.id === name,
        )
      )
        throw new Error('Duplicate root path or name (including canonical symlink/case aliases).');
      if (inside(this.state, canonical))
        throw new Error('Cannot register Kode-owned state as a source root.');
      const root: Root = { id: randomUUID(), name, path: canonical, access, kind };
      if (registry.roots.length >= 100)
        throw new Error('Workspace supports at most 100 registered roots.');
      registry.roots.push(root);
      await atomicJson(join(this.state, 'workspace.json'), registry);
      return root;
    });
  }
  async remove(id: string) {
    const root = await this.root(id);
    return leased(join(this.state, 'registry.lock'), async () => {
      const registry = await this.list();
      registry.roots = registry.roots.filter((item) => item.id !== root.id);
      await atomicJson(join(this.state, 'workspace.json'), registry);
      return { unregistered: root.id, sourceDeleted: false };
    });
  }
  private async scan(root: Root) {
    const entries: FileEntry[] = [];
    const contents = new Map<string, Buffer>();
    let names: string[] = [];
    let head: string | null = null,
      branch: string | null = null,
      status = '',
      indexHash = '',
      indexEntries = '';
    if (root.kind === 'git') {
      head = (await git(root.path, ['rev-parse', '--verify', 'HEAD'])).stdout.trim() || null;
      branch =
        (await git(root.path, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() || null;
      status = await requiredGit(root.path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]);
      const index = await requiredGit(root.path, ['ls-files', '--stage', '-z']);
      indexEntries = index;
      if (index.split('\0').some((entry) => /^\d+ \w+ [123]\t/.test(entry)))
        throw new Error(
          'Blocked: resolve unmerged index conflicts before capturing a task baseline.',
        );
      if (index.split('\0').some((entry) => entry.startsWith('160000 ')))
        throw new Error(
          'Blocked: register submodules as separate roots; gitlink snapshots are unsupported.',
        );
      indexHash = hash(index);
      names = [
        ...new Set(
          (
            await requiredGit(root.path, [
              'ls-files',
              '-z',
              '--cached',
              '--others',
              '--exclude-standard',
            ])
          )
            .split('\0')
            .filter(Boolean),
        ),
      ];
    } else {
      const walk = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (omitted.has(entry.name)) continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            // Nested repositories are separate registration/capture boundaries.
            if (
              await lstat(join(path, '.git')).then(
                () => true,
                () => false,
              )
            )
              continue;
            await walk(path);
          } else names.push(relative(root.path, path).replaceAll('\\', '/'));
        }
      };
      await walk(root.path);
    }
    for (const name of names.sort()) {
      if (name.split('/').some((part) => omitted.has(part))) continue;
      const path = scoped(root.path, name);
      const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!metadata) continue; // A tracked deletion remains represented in porcelain provenance.
      if (!inside(root.path, await realpath(path)) || metadata.isSymbolicLink())
        throw new Error(`Blocked: file symlink needs an explicit policy: ${name}`);
      if (
        metadata.isDirectory() &&
        (await lstat(join(path, '.git')).then(
          () => true,
          () => false,
        ))
      )
        continue;
      if (!metadata.isFile()) throw new Error(`Blocked: unsupported source entry: ${name}`);
      if (metadata.size > 32 * 1024 * 1024)
        throw new Error(`Source file exceeds 32 MiB capture limit: ${name}`);
      const bytes = await readFile(path);
      const digest = hash(bytes);
      entries.push({ path: name, hash: digest, executable: Boolean(metadata.mode & 0o111) });
      contents.set(digest, bytes);
    }
    const input = { head, branch, status, indexHash, indexEntries, files: entries };
    return { ...input, digest: hash(JSON.stringify(input)), contents };
  }
  async capture(id: string, afterScan?: () => Promise<void>) {
    const root = await this.root(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await this.scan(root);
      await afterScan?.();
      const second = await this.scan(root);
      if (first.digest !== second.digest) continue;
      const baseline: Baseline = {
        version: 1,
        id: randomUUID(),
        rootId: root.id,
        head: first.head,
        branch: first.branch,
        status: first.status,
        indexHash: first.indexHash,
        indexEntries: first.indexEntries,
        files: first.files,
        digest: first.digest,
        capturedAt: new Date().toISOString(),
      };
      for (const [digest, bytes] of first.contents) {
        const path = join(this.state, 'blobs', digest);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }).catch(
          async (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
            if (hash(await readFile(path)) !== digest)
              throw new Error('Stored baseline blob is corrupt.', { cause: error });
          },
        );
      }
      await atomicJson(join(this.state, 'baselines', `${baseline.id}.json`), baseline);
      return baseline;
    }
    throw new Error(
      'Blocked: source changed during all three baseline capture attempts; retry when stable.',
    );
  }
  async createTree(id: string, baselineId?: string, access: Root['access'] = 'write') {
    const root = await this.root(id);
    if (access === 'write' && root.access !== 'write')
      throw new Error('Read-only root cannot grant task write scope.');
    if (baselineId && !/^[a-f0-9-]{36}$/.test(baselineId)) throw new Error('Invalid baseline ID.');
    const baseline = baselineId
      ? BaselineSchema.parse(
          await json<Baseline>(join(this.state, 'baselines', `${baselineId}.json`)),
        )
      : await this.capture(root.id);
    if (baseline.rootId !== root.id) throw new Error('Baseline belongs to another root.');
    if (
      baseline.digest !==
      hash(
        JSON.stringify({
          head: baseline.head,
          branch: baseline.branch,
          status: baseline.status,
          indexHash: baseline.indexHash,
          indexEntries: baseline.indexEntries,
          files: baseline.files,
        }),
      )
    )
      throw new Error('Baseline manifest integrity mismatch.');
    const idTree = randomUUID();
    const path = join(this.state, 'trees', idTree, 'source');
    await mkdir(dirname(path), { recursive: true });
    const mode = root.kind === 'git' && baseline.head ? 'worktree' : 'snapshot';
    // Ordinary folders/unborn repos have a serialized snapshot materialization boundary.
    return leased(join(this.state, `capture-${root.id}.lock`), async () => {
      if (mode === 'worktree') {
        const hooks = join(this.state, 'empty-hooks');
        await mkdir(hooks, { recursive: true });
        // Materialize captured bytes ourselves: checkout hooks/filters must not mutate
        // source or start installs while constructing the task's input snapshot.
        await requiredGit(root.path, [
          '-c',
          `core.hooksPath=${hooks}`,
          'worktree',
          'add',
          '--detach',
          '--no-checkout',
          path,
          baseline.head!,
        ]);
        await requiredGit(path, ['-c', `core.hooksPath=${hooks}`, 'read-tree', 'HEAD']);
        for (const entry of await readdir(path))
          if (entry !== '.git') await rm(join(path, entry), { recursive: true, force: true });
      } else await mkdir(path);
      try {
        for (const file of baseline.files) {
          if (file.path.split('/').some((part) => omitted.has(part)))
            throw new Error('Baseline entry addresses a reserved path.');
          const bytes = await readFile(join(this.state, 'blobs', file.hash));
          if (hash(bytes) !== file.hash) throw new Error('Baseline content hash mismatch.');
          const target = scoped(path, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
          if (process.platform !== 'win32') await chmod(target, file.executable ? 0o755 : 0o644);
        }
        const tree: TaskTree = {
          version: 1,
          id: idTree,
          rootId: root.id,
          baseline: baseline.id,
          path,
          source: root.path,
          mode,
          access,
          retained: false,
        };
        await atomicJson(join(this.state, 'trees', idTree, 'tree.json'), tree);
        return tree;
      } catch (error) {
        // Keep incomplete data for diagnosis; no unowned source is removed on failure.
        throw new Error(`Task materialization blocked; incomplete owned data: ${path}`, {
          cause: error,
        });
      }
    });
  }
  async tree(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task tree ID.');
    const tree = TreeSchema.parse(await json<TaskTree>(join(this.state, 'trees', id, 'tree.json')));
    if (
      tree.id !== id ||
      tree.path !== join(this.state, 'trees', id, 'source') ||
      (await realpath(tree.path)) !== tree.path
    )
      throw new Error('Task tree ownership/path mismatch.');
    return tree;
  }
  async retain(id: string) {
    const tree = await this.tree(id);
    tree.retained = true;
    await atomicJson(join(this.state, 'trees', id, 'tree.json'), tree);
    return tree;
  }
  async cleanup(id: string) {
    const tree = await this.tree(id);
    if (tree.retained) throw new Error('Tree is retained by evidence; cleanup refused.');
    const lease = join(this.state, 'tree-locks', `${id}.lock`);
    if (
      await lstat(lease).then(
        () => true,
        () => false,
      )
    )
      throw new Error('Tree is leased; cleanup refused.');
    await leased(lease, async () => {
      const current = await this.tree(id);
      if (current.retained) throw new Error('Tree is retained by evidence; cleanup refused.');
      if (tree.mode === 'worktree')
        await requiredGit(tree.source, ['worktree', 'remove', '--force', tree.path]);
      await rm(join(this.state, 'trees', id), { recursive: true, force: true });
    });
    return { removed: id, sourceDeleted: false, baselineRetained: true };
  }
}
