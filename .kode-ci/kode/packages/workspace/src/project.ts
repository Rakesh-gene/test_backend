import { randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { redact, safeTerminal } from '@kode/contracts';
import {
  findExecutable,
  effectiveEnvironment,
  windowsOwnership,
  commandHost,
} from '@kode/execution';
import { inside, scoped } from './state.js';
import { containerCommand } from './isolation.js';

const relativePath = z
  .string()
  .min(1)
  .refine((path) => {
    try {
      scoped('/kode-scope', path);
      return !path.includes('\\') && !/^[A-Za-z]:/.test(path);
    } catch {
      return false;
    }
  }, 'Must be a relative path within the repository; use forward slashes.');
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/);
export const CommandSpec = z
  .object({
    run: z.array(z.string().max(8192)).min(1).max(100),
    cwd: relativePath.default('.'),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
    timeout_seconds: z.number().positive().max(3600).default(180),
    services: z.array(name).default([]),
    reports: z
      .array(z.object({ format: z.enum(['junit', 'json']), path: relativePath }).strict())
      .default([]),
    artifacts: z.array(relativePath).default([]),
  })
  .strict();
export const RepoManifest = z
  .object({
    version: z.literal(1),
    dependencies: z
      .object({
        manager: z.enum(['none', 'npm', 'nuget']),
        reuse: z.enum(['auto', 'never']).default('auto'),
        prepare: name.optional(),
        validate: name.optional(),
        projects: z.array(relativePath).min(1).optional(),
        inputs: z.array(relativePath).default([]),
        flags: z.array(z.string()).default([]),
      })
      .strict()
      .default({ manager: 'none', reuse: 'auto', inputs: [], flags: [] }),
    commands: z.record(name, CommandSpec),
    services: z
      .record(
        name,
        z
          .object({
            command: name,
            depends_on: z.array(name).default([]),
            port: z
              .union([z.literal('auto'), z.number().int().min(1024).max(65535)])
              .default('auto'),
            readiness: z
              .object({
                http: z.string().min(1),
                timeout_seconds: z.number().positive().max(300).default(60),
              })
              .strict(),
            setup: name.optional(),
            cleanup: name.optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict()
  .superRefine((manifest, context) => {
    const error = (message: string) => context.addIssue({ code: 'custom', message });
    const hasCommand = (value: string) => {
      if (!manifest.commands[value]) error(`Unknown command: ${value}`);
    };
    if (manifest.dependencies.prepare) hasCommand(manifest.dependencies.prepare);
    if (manifest.dependencies.validate) hasCommand(manifest.dependencies.validate);
    for (const command of Object.values(manifest.commands))
      for (const service of command.services)
        if (!manifest.services[service]) error(`Unknown service: ${service}`);
    const visiting = new Set<string>(),
      seen = new Set<string>();
    function visit(id: string) {
      if (visiting.has(id)) {
        error(`Service dependency cycle: ${id}`);
        return;
      }
      if (seen.has(id)) return;
      const service = manifest.services[id];
      if (!service) {
        error(`Unknown service dependency: ${id}`);
        return;
      }
      visiting.add(id);
      hasCommand(service.command);
      if (service.setup) hasCommand(service.setup);
      if (service.cleanup) hasCommand(service.cleanup);
      for (const dependency of service.depends_on) visit(dependency);
      visiting.delete(id);
      seen.add(id);
    }
    for (const id of Object.keys(manifest.services)) visit(id);
  });
export type Manifest = z.infer<typeof RepoManifest>;
export type CommandDefinition = z.infer<typeof CommandSpec>;
export interface Activity {
  phase: string;
  name: string;
  status: string;
  [key: string]: unknown;
}
export type Observer = (activity: Activity) => Promise<void>;
export const quiet: Observer = async () => {};
export async function loadManifest(path: string) {
  const text = await readFile(join(path, 'kode.yaml'), 'utf8').catch((error) => {
    throw new Error('Missing kode.yaml. Run kode repo init <root>.', { cause: error });
  });
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`Invalid kode.yaml: ${document.errors.map(String).join('; ')}`);
  const parsed = RepoManifest.safeParse(document.toJS({ maxAliasCount: 20 }));
  if (!parsed.success) throw new Error(`Invalid kode.yaml: ${parsed.error.message}`);
  return parsed.data;
}
export async function initManifest(path: string, manager: 'npm' | 'nuget' | 'none') {
  const commands =
    manager === 'npm'
      ? {
          install: { run: ['npm', 'ci'], timeout_seconds: 300 },
          build: { run: ['npm', 'run', 'build'] },
          test: { run: ['npm', 'test'] },
        }
      : manager === 'nuget'
        ? {
            restore: { run: ['dotnet', 'restore'], timeout_seconds: 300 },
            build: { run: ['dotnet', 'build', '--no-restore'] },
            test: { run: ['dotnet', 'test', '--no-restore'] },
          }
        : {};
  await writeFile(
    join(path, 'kode.yaml'),
    stringify({
      version: 1,
      dependencies: {
        manager,
        reuse: 'auto',
        ...(manager !== 'none' ? { prepare: manager === 'npm' ? 'install' : 'restore' } : {}),
      },
      commands,
    }),
    { flag: 'wx' },
  );
  return loadManifest(path);
}
export async function commandDirectory(root: string, spec: CommandDefinition) {
  const path = await realpath(scoped(root, spec.cwd));
  if (!inside(await realpath(root), path))
    throw new Error('Command cwd escapes task root through a symlink.');
  return path;
}
export function substitute(value: string, ports: Record<string, number>) {
  return value.replace(/\$\{port:([A-Za-z0-9_.-]+)\}/g, (_, id: string) => {
    if (!ports[id]) throw new Error(`Port is not assigned for service ${id}.`);
    return String(ports[id]);
  });
}
function secretValues(env: Record<string, string | undefined>) {
  return Object.entries(env)
    .filter(([key]) =>
      /secret|token|password|api_?key|authorization|connection[-_]?strings?/i.test(key),
    )
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value));
}
export async function startProcess(
  root: string,
  spec: CommandDefinition,
  ports: Record<string, number> = {},
  extraEnv: Record<string, string> = {},
) {
  const executable = spec.run[0]!;
  const cwd = await commandDirectory(root, spec);
  const env = effectiveEnvironment(
    Object.fromEntries(
      Object.entries({ ...spec.env, ...extraEnv }).map(([key, value]) => [
        key,
        substitute(value, ports),
      ]),
    ),
  );
  const isolated = await containerCommand(
    root,
    cwd,
    spec.run.map((arg) => substitute(arg, ports)),
    Object.fromEntries(
      Object.entries({ ...spec.env, ...extraEnv }).map(([key, value]) => [
        key,
        substitute(value, ports),
      ]),
    ),
  );
  const resolved =
    isolated?.executable ??
    findExecutable(executable, env.PATH) ??
    (executable === process.execPath ? process.execPath : undefined);
  if (!resolved) throw new Error(`Missing tool '${executable}'; install it and add it to PATH.`);
  const secrets = secretValues({ ...process.env, ...env });
  const ownership = windowsOwnership();
  const args = isolated?.args ?? spec.run.slice(1).map((arg) => substitute(arg, ports));
  const child = execa(
    ownership ? process.execPath : resolved,
    ownership ? [commandHost, resolved, ...args] : args,
    {
      cwd,
      env: isolated ? process.env : env,
      extendEnv: false,
      reject: false,
      windowsHide: true,
      stdin: ownership || isolated ? 'pipe' : 'ignore',
      detached: process.platform !== 'win32',
      maxBuffer: 256 * 1024,
      timeout: spec.timeout_seconds * 1000,
      forceKillAfterDelay: 500,
    },
  );
  if (ownership) {
    try {
      if (!child.pid) throw new Error('Command host failed to start.');
      ownership.assign(child.pid);
      child.nodeChildProcess.once('exit', () => ownership.close());
      if (isolated) child.stdin!.write('KODE_GO\n');
      else child.stdin!.end('KODE_GO\n');
    } catch (error) {
      child.kill();
      ownership.close();
      void child.catch(() => {});
      throw error;
    }
  }
  // Attach immediately so startup/output/timeout failures never become unhandled rejections.
  const settled = child.then(
    (result) => result,
    (error: unknown) => {
      throw new Error('Command startup or output limit failed; inspect tool configuration.', {
        cause: error,
      });
    },
  );
  void settled.catch(() => {});
  let stopping: Promise<void> | undefined;
  function stop() {
    return (stopping ??= terminate());
  }
  async function terminate() {
    if (isolated) {
      try {
        await isolated.cleanup();
      } finally {
        child.stdin?.end();
        ownership?.close();
      }
      return;
    }
    if (ownership) {
      ownership.close();
      return;
    }
    if (child.pid) {
      if (process.platform === 'win32') {
        if (
          child.nodeChildProcess.exitCode === null &&
          child.nodeChildProcess.signalCode === null
        ) {
          const result = await execa('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            reject: false,
            windowsHide: true,
            timeout: 3000,
          });
          if (
            result.exitCode !== 0 &&
            child.nodeChildProcess.exitCode === null &&
            child.nodeChildProcess.signalCode === null
          ) {
            child.kill();
            throw new Error(
              'OS refused owned process-tree teardown; direct child was stopped, descendant cleanup is unconfirmed.',
            );
          }
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* Already exited. */
        }
        await new Promise((r) => setTimeout(r, 100));
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    }
  }
  return {
    child,
    settled,
    stop,
    clean: (text: string) => safeTerminal(String(redact(text, secrets))),
  };
}
export interface CommandResult {
  id: string;
  name: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}
export async function runDeclared(
  root: string,
  manifest: Manifest,
  name: string,
  options: {
    signal?: AbortSignal;
    ports?: Record<string, number>;
    env?: Record<string, string>;
    observe?: Observer;
  } = {},
): Promise<CommandResult> {
  const spec = manifest.commands[name];
  if (!spec)
    throw new Error(
      `Unknown command '${name}'. Available: ${Object.keys(manifest.commands).join(', ')}`,
    );
  if (options.signal?.aborted) throw new Error('Command cancelled before dispatch.');
  const id = randomUUID(),
    start = Date.now(),
    observe = options.observe ?? quiet;
  await observe({ phase: 'command', name, status: 'running', id });
  const running = await startProcess(root, spec, options.ports, options.env);
  const cancel = () => {
    void running.stop().catch(() => {});
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  // A separate owner timer tears down descendants as well as the direct command.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    cancel();
  }, spec.timeout_seconds * 1000);
  let bytes = 0;
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
  };
  running.child.stdout?.on('data', count);
  running.child.stderr?.on('data', count);
  const progress = setInterval(() => {
    void observe({ phase: 'command', name, status: 'running', id, outputBytes: bytes }).catch(
      () => {},
    );
  }, 500);
  try {
    const result = await running.settled;
    const status = options.signal?.aborted
      ? 'cancelled'
      : timedOut || result.timedOut
        ? 'timed_out'
        : result.exitCode === 0
          ? 'passed'
          : 'failed';
    const output: CommandResult = {
      id,
      name,
      status,
      exitCode: result.exitCode ?? null,
      stdout: running.clean(String(result.stdout ?? '')).slice(-16000),
      stderr: running.clean(String(result.stderr ?? '')).slice(-16000),
      durationMs: Date.now() - start,
    };
    await observe({
      phase: 'command',
      name,
      status,
      id,
      exitCode: output.exitCode,
      outputBytes: bytes,
    });
    return output;
  } finally {
    clearInterval(progress);
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
    await running.stop();
  }
}
