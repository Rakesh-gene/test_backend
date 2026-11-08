import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { findExecutable } from '@kode/execution';
import { atomicJson, hash, json, inside } from './state.js';

export const ExecutionPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('native') }).strict(),
  z
    .object({
      mode: z.literal('container'),
      image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      reference: z.string().max(300),
    })
    .strict(),
]);
export type Execution = z.infer<typeof ExecutionPolicy>;
const context = new AsyncLocalStorage<{ policy: Execution; control: string; root: string }>();
export const withExecution = <T>(
  value: NonNullable<ReturnType<typeof context.getStore>>,
  run: () => T,
) => context.run(value, run);
export const currentExecution = () => context.getStore();
const policyFile = (state: string) => join(state, 'control', 'execution.json');
export async function executionPolicy(state: string): Promise<Execution> {
  return ExecutionPolicy.parse(
    await json(policyFile(state)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return { mode: 'native' };
      throw error;
    }),
  );
}
async function docker() {
  const executable = findExecutable('docker');
  if (!executable) throw new Error('Container isolation requires Docker. No native fallback.');
  const endpoint =
    process.env.DOCKER_HOST ??
    (
      await execa(executable, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
        windowsHide: true,
        timeout: 10000,
      })
    ).stdout.trim();
  if (!/^(unix:\/\/\/|npipe:\/\/)/.test(endpoint))
    throw new Error('Strict bind mounts require a local Docker endpoint. No native fallback.');
  return executable;
}
export async function configureExecution(state: string, image?: string): Promise<Execution> {
  let policy: Execution = { mode: 'native' };
  if (image) {
    if (image.startsWith('-') || image.length > 300) throw new Error('Invalid image reference.');
    const tool = await docker();
    const result = await execa(tool, ['image', 'inspect', image, '--format', '{{json .}}'], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const inspected = JSON.parse(result.stdout) as {
      Id: string;
      Os: string;
      Config?: { Volumes?: Record<string, unknown> };
    };
    if (inspected.Os !== 'linux' || Object.keys(inspected.Config?.Volumes ?? {}).length)
      throw new Error('Use a local Linux image without declared anonymous volumes.');
    policy = ExecutionPolicy.parse({ mode: 'container', image: inspected.Id, reference: image });
  }
  await mkdir(join(state, 'control'), { recursive: true, mode: 0o700 });
  await atomicJson(policyFile(state), policy);
  return policy;
}

const Descriptor = z
  .object({
    id: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    owner: z.string().uuid(),
    image: z.string(),
    workspace: z.string(),
  })
  .strict();
async function removeOwned(tool: string, descriptor: z.infer<typeof Descriptor>) {
  const result = await execa(
    tool,
    ['inspect', descriptor.id ?? `kode-${descriptor.owner}`, '--format', '{{json .}}'],
    { reject: false, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  if (result.exitCode !== 0) {
    if (/No such (object|container)/i.test(result.stderr)) return;
    throw new Error('Cannot reconcile owned container; Docker inspection is unavailable.');
  }
  const actual = JSON.parse(result.stdout) as {
    Id: string;
    Image: string;
    Config: { Labels: Record<string, string> };
  };
  if (
    (descriptor.id && actual.Id !== descriptor.id) ||
    actual.Image !== descriptor.image ||
    actual.Config.Labels['kode.owner'] !== descriptor.owner ||
    actual.Config.Labels['kode.workspace'] !== descriptor.workspace
  )
    throw new Error('Container ownership mismatch; no container was removed.');
  const removed = await execa(tool, ['rm', '--force', actual.Id], {
    reject: false,
    windowsHide: true,
    timeout: 10000,
  });
  if (removed.exitCode !== 0 && !/No such (object|container)/i.test(removed.stderr))
    throw new Error('Owned container teardown failed; its descriptor is retained.');
}
export async function recoverContainers(state: string) {
  const directory = join(state, 'control', 'containers');
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (!files.length) return;
  const tool = await docker();
  for (const file of files) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const path = join(directory, file),
      descriptor = Descriptor.parse(await json(path));
    if (descriptor.owner + '.json' !== file || descriptor.workspace !== hash(await realpath(state)))
      throw new Error('Container recovery descriptor is outside this workspace.');
    await removeOwned(tool, descriptor);
    await unlink(path);
  }
}

export async function containerCommand(
  root: string,
  cwd: string,
  args: string[],
  env: Record<string, string>,
) {
  const selected = context.getStore();
  if (!selected || selected.policy.mode !== 'container') return undefined;
  const canonical = await realpath(root);
  if (
    canonical !== (await realpath(selected.root)) ||
    !inside(canonical, cwd) ||
    canonical.includes(',')
  )
    throw new Error('Container mount must be the selected isolated task tree (without commas).');
  const tool = await docker(),
    owner = randomUUID();
  const workspace = hash(await realpath(join(selected.control, '..')));
  const directory = join(selected.control, 'containers');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${owner}.json`);
  const uid = process.getuid?.() || 1000,
    gid = process.getgid?.() || 1000;
  // Root-owned guard and EOF watcher cannot be signalled by the unprivileged
  // command. PID-namespace teardown also kills setsid/double-fork descendants.
  const bootstrap = `
set -eu
/bin/mkdir -p /tmp/kode-home
/bin/chmod 777 /tmp/kode-home
trap 'exit 125' TERM HUP INT
exec 3<&0
( while IFS= read -r line <&3; do :; done; kill -TERM 1 ) <&3 &
/usr/bin/setpriv --reuid=${uid} --regid=${gid} --clear-groups -- /usr/bin/env -i -- "$@" </dev/null &
target=$!
set +e
wait "$target"
result=$?
exit "$result"
`;
  const targetEnv = {
    HOME: '/tmp/kode-home',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NPM_CONFIG_CACHE: '/workspace/.kode-cache/npm',
    NUGET_PACKAGES: '/workspace/.kode-cache/nuget',
    DOTNET_CLI_HOME: '/tmp/kode-home',
    ...env,
  };
  await atomicJson(file, { owner, image: selected.policy.image, workspace });
  const create = await execa(
    tool,
    [
      'create',
      '--pull',
      'never',
      '--name',
      `kode-${owner}`,
      '--interactive',
      '--attach',
      'stdin',
      '--attach',
      'stdout',
      '--attach',
      'stderr',
      '--init',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'SETUID',
      '--cap-add',
      'SETGID',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '1g',
      '--cpus',
      '2',
      '--no-healthcheck',
      '--user',
      '0:0',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=256m',
      '--tmpfs',
      '/workspace/.kode:ro,nosuid,nodev,size=1m',
      '--mount',
      `type=bind,src=${canonical},dst=/workspace`,
      '--workdir',
      `/workspace/${relative(canonical, cwd).replaceAll('\\', '/')}`,
      '--label',
      `kode.owner=${owner}`,
      '--label',
      `kode.workspace=${workspace}`,
      '--entrypoint',
      '/bin/sh',
      selected.policy.image,
      '-c',
      bootstrap,
      'kode-host',
      ...Object.entries(targetEnv).map(([key, value]) => `${key}=${value}`),
      ...args,
    ],
    { windowsHide: true, timeout: 20000 },
  );
  const descriptor = Descriptor.parse({
    id: create.stdout.trim(),
    owner,
    image: selected.policy.image,
    workspace,
  });
  try {
    await atomicJson(file, descriptor);
  } catch (error) {
    await removeOwned(tool, descriptor);
    throw error;
  }
  return {
    executable: tool,
    args: ['start', '--attach', '--interactive', descriptor.id!],
    async cleanup() {
      await removeOwned(tool, descriptor);
      await unlink(file).catch(() => {});
    },
  };
}
