import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Workspace,
  initManifest,
  loadManifest,
  prepareEnvironment,
  runWithServices,
  atomicJson,
  json,
  leased,
  type Observer,
} from '@kode/workspace';
import type { Request } from '@kode/contracts';
import { redact } from '@kode/contracts';
import { SpanStatusCode, type telemetry } from '@kode/observability';

const RootId = z.object({ root: z.string().min(1).max(160) }).strict();
const TreeId = z.object({ tree: z.string().uuid() }).strict();
const Target = RootId.extend({ tree: z.string().uuid().optional() });
const JobStart = Target.extend({
  kind: z.enum(['command', 'environment']),
  command: z.string().max(80).optional(),
  offline: z.boolean().default(false),
}).strict();
interface Job {
  id: string;
  status: string;
  kind: string;
  root: string;
  tree?: string;
  result?: unknown;
  error?: string;
}
export function workspaceMethods(
  path: string,
  observer: Observer,
  observability: Pick<ReturnType<typeof telemetry>, 'operation'>,
) {
  const workspace = new Workspace(path);
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  async function target(params: z.infer<typeof Target>, write: boolean) {
    const root = await workspace.root(params.root);
    const tree = params.tree ? await workspace.tree(params.tree) : undefined;
    if (tree && tree.rootId !== root.id) throw new Error('Task tree belongs to another root.');
    if (write && (root.access !== 'write' || tree?.access === 'read'))
      throw new Error(
        'Read-only scope cannot execute arbitrary commands or write configuration. OS sandboxing is not available through this launcher.',
      );
    return { root, tree, path: tree?.path ?? root.path };
  }
  return {
    workspace,
    async stop() {
      for (const item of active.values()) item.controller.abort();
      await Promise.allSettled([...active.values()].map((item) => item.done));
    },
    async handle(request: Request): Promise<unknown> {
      const params = request.params;
      switch (request.method) {
        case 'workspace.init':
          return workspace.init();
        case 'folder.list':
          return workspace.list();
        case 'folder.add': {
          const p = z
            .object({
              path: z.string().min(1),
              name: z.string().min(1),
              access: z.enum(['read', 'write']).default('read'),
            })
            .strict()
            .parse(params);
          return workspace.add(p.path, p.name, p.access);
        }
        case 'folder.remove':
          return workspace.remove(RootId.parse(params).root);
        case 'baseline.capture': {
          const baseline = await workspace.capture(RootId.parse(params).root);
          return {
            id: baseline.id,
            digest: baseline.digest,
            files: baseline.files.length,
            head: baseline.head,
            manifest: join(workspace.state, 'baselines', `${baseline.id}.json`),
          };
        }
        case 'tree.create': {
          const p = RootId.extend({
            baseline: z.string().uuid().optional(),
            access: z.enum(['read', 'write']).default('write'),
          }).parse(params);
          return workspace.createTree(p.root, p.baseline, p.access);
        }
        case 'tree.cleanup':
          return workspace.cleanup(TreeId.parse(params).tree);
        case 'tree.retain':
          return workspace.retain(TreeId.parse(params).tree);
        case 'repo.init': {
          const p = Target.extend({
            manager: z.enum(['npm', 'nuget', 'none']).default('none'),
          }).parse(params);
          const destination = await target(p, true);
          return initManifest(destination.path, p.manager);
        }
        case 'repo.inspect': {
          const p = Target.parse(params);
          const destination = await target(p, false);
          const manifest = await loadManifest(destination.path);
          return {
            root: destination.root,
            tree: destination.tree,
            commands: Object.keys(manifest.commands),
            services: Object.keys(manifest.services),
            dependencies: manifest.dependencies,
            executionBoundary:
              'cwd and managed-file scope only; arbitrary commands require write scope and are not OS-sandboxed',
          };
        }
        case 'env.inspect': {
          const p = Target.parse(params);
          return prepareEnvironment(workspace, p.root, { treeId: p.tree, inspect: true });
        }
        case 'job.start': {
          const p = JobStart.parse(params);
          const destination = await target(p, true);
          if (p.kind === 'command' && !p.command) throw new Error('A named command is required.');
          const id = randomUUID();
          const controller = new AbortController();
          const job: Job = {
            id,
            status: 'running',
            kind: p.kind,
            root: destination.root.id,
            tree: p.tree,
          };
          const file = join(workspace.state, 'jobs', `${id}.json`);
          await mkdir(join(workspace.state, 'jobs'), { recursive: true });
          await atomicJson(file, job);
          const observe: Observer = (activity) =>
            observer({ ...activity, jobId: id, root: destination.root.name, tree: p.tree });
          const execute = async () => {
            try {
              if (controller.signal.aborted) throw new Error('Job cancelled before dispatch.');
              if (p.tree) await workspace.tree(p.tree);
              job.result =
                p.kind === 'environment'
                  ? await prepareEnvironment(workspace, p.root, {
                      treeId: p.tree,
                      offline: p.offline,
                      signal: controller.signal,
                      observe,
                    })
                  : await runWithServices(
                      destination.path,
                      await loadManifest(destination.path),
                      p.command!,
                      { signal: controller.signal, observe },
                    );
              const status = (job.result as { status?: string }).status;
              job.status = controller.signal.aborted
                ? 'cancelled'
                : status && status !== 'passed'
                  ? status
                  : 'passed';
            } catch (error) {
              job.status = controller.signal.aborted ? 'cancelled' : 'failed';
              // Exceptions may include command output. Redact configured/inherited credentials before persistence.
              const secrets = Object.entries(process.env)
                .filter(([key]) =>
                  /secret|token|password|api_?key|connection[-_]?strings?/i.test(key),
                )
                .map(([, value]) => value ?? '');
              job.error = String(redact(String(error), secrets)).slice(0, 4000);
            } finally {
              await atomicJson(file, job);
              active.delete(id);
            }
          };
          const traced = () =>
            observability.operation('workspace.job', async (span) => {
              span.setAttribute('kode.job.id', id);
              span.setAttribute('kode.root.id', destination.root.id);
              if (p.tree) span.setAttribute('kode.tree.id', p.tree);
              await execute();
              if (job.status !== 'passed')
                span.setStatus({ code: SpanStatusCode.ERROR, message: `Job ${job.status}` });
            });
          const done = (
            p.tree
              ? leased(join(workspace.state, 'tree-locks', `${p.tree}.lock`), traced)
              : leased(join(workspace.state, 'root-locks', `${destination.root.id}.lock`), traced)
          ).catch(async () => {
            job.status = 'blocked';
            job.error = 'Execution lease failed.';
            await atomicJson(file, job);
            active.delete(id);
          });
          active.set(id, { controller, done });
          return { id, status: 'running' };
        }
        case 'job.get': {
          const p = z.object({ id: z.string().uuid() }).strict().parse(params);
          const job = await json<Job>(join(workspace.state, 'jobs', `${p.id}.json`));
          if (job.status === 'running' && !active.has(p.id))
            return {
              ...job,
              status: 'blocked',
              error: 'Interrupted runner: reconcile environment/process state before retrying.',
            };
          return job;
        }
        case 'job.cancel': {
          const p = z.object({ id: z.string().uuid() }).strict().parse(params);
          const item = active.get(p.id);
          if (!item) throw new Error('Job is not active; inspect its durable result.');
          item.controller.abort();
          return { id: p.id, cancellationRequested: true };
        }
        default:
          throw new Error(`Unknown workspace method: ${request.method}`);
      }
    },
  };
}
