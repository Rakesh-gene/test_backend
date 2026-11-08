import { mkdir, readdir } from 'node:fs/promises';
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
  configureExecution,
  executionPolicy,
  recoverContainers,
  withExecution,
  type Execution,
  type Observer,
} from '@kode/workspace';
import type { Request } from '@kode/contracts';
import { redact, TraceContext } from '@kode/contracts';
import {
  SpanStatusCode,
  captureTraceContext,
  traceCorrelation,
  withTraceContext,
  type TraceCarrier,
  type telemetry,
} from '@kode/observability';

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
  execution?: Execution;
  result?: unknown;
  error?: string;
  traceContext?: TraceCarrier;
  trace_id?: string;
  span_id?: string;
  recovery?: { outcome: 'unknown'; correlation: 'preserved' | 'unavailable'; reconciledAt: string };
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
    async recover() {
      await recoverContainers(workspace.state);
      const directory = join(workspace.state, 'jobs');
      const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const name of files) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const file = join(directory, name);
        const job = await json<Job>(file);
        if (job.id + '.json' !== name) throw new Error('Job descriptor identity mismatch.');
        if (job.status !== 'running') continue;
        const saved = TraceContext.safeParse(job.traceContext);
        const preserved = withTraceContext(saved.success ? saved.data : undefined, () =>
          Boolean(captureTraceContext().traceparent),
        );
        await withTraceContext(saved.success ? saved.data : undefined, () =>
          observability.operation('workspace.job.reconcile', async (span) => {
            const correlation = preserved ? 'preserved' : 'unavailable';
            span.setAttribute('kode.job.id', job.id);
            span.setAttribute('kode.job.prior_outcome', 'unknown');
            span.setAttribute('kode.trace.continuity', correlation);
            job.status = 'blocked';
            job.error =
              'Interrupted runner: prior action outcome is unknown. Reconcile process/environment state before retrying; no action was replayed.';
            job.recovery = {
              outcome: 'unknown',
              correlation,
              reconciledAt: new Date().toISOString(),
            };
            // Audit the real reconciliation attempt before publishing its descriptor.
            // A crash here may cause another reconciliation attempt, never an action retry.
            await observer({
              phase: 'job',
              name: job.id,
              jobId: job.id,
              root: job.root,
              tree: job.tree,
              status: 'blocked',
              outcome: 'unknown',
              correlation,
              recovery: true,
              replayed: false,
            });
            await atomicJson(file, job);
          }),
        );
      }
    },
    async stop() {
      for (const item of active.values()) item.controller.abort();
      await Promise.allSettled([...active.values()].map((item) => item.done));
    },
    async handle(request: Request): Promise<unknown> {
      const params = request.params;
      switch (request.method) {
        case 'execution.configure': {
          if (active.size)
            throw new Error('Wait for active commands before changing execution policy.');
          const p = z
            .object({
              mode: z.enum(['native', 'container']),
              image: z.string().min(1).max(300).optional(),
            })
            .strict()
            .parse(params);
          if (p.mode === 'container' && !p.image)
            throw new Error('Select a local container image.');
          return configureExecution(workspace.state, p.mode === 'container' ? p.image : undefined);
        }
        case 'execution.inspect':
          return executionPolicy(workspace.state);
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
            executionBoundary: await executionPolicy(workspace.state),
          };
        }
        case 'env.inspect': {
          if ((await executionPolicy(workspace.state)).mode === 'container')
            throw new Error(
              'Native environment receipts cannot validate container dependencies. Run declared preparation inside the selected task tree; container receipt adapters are not available yet.',
            );
          const p = Target.parse(params);
          return prepareEnvironment(workspace, p.root, { treeId: p.tree, inspect: true });
        }
        case 'job.start': {
          const p = JobStart.parse(params);
          const destination = await target(p, true);
          const policy = await executionPolicy(workspace.state);
          if (policy.mode === 'container') {
            if (!destination.tree)
              throw new Error(
                'Container commands require an isolated task tree. Source installations are preserved.',
              );
            if (p.kind === 'environment')
              throw new Error(
                'Native environment preparation is disabled in container mode; run the declared setup command in the task tree.',
              );
            const manifest = await loadManifest(destination.path);
            if (manifest.commands[p.command ?? '']?.services.length)
              throw new Error(
                'Strict container commands do not expose host services or ports. No native fallback.',
              );
          }
          if (p.kind === 'command' && !p.command) throw new Error('A named command is required.');
          const id = randomUUID();
          const controller = new AbortController();
          const job: Job = {
            id,
            status: 'running',
            kind: p.kind,
            root: destination.root.id,
            tree: p.tree,
            execution: policy,
            traceContext: captureTraceContext(),
            ...traceCorrelation(),
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
              job.traceContext = captureTraceContext();
              Object.assign(job, traceCorrelation());
              await atomicJson(file, job); // Persist correlation before any external dispatch.
              await observe({ phase: 'job', name: id, status: 'running', dispatch: 'pending' });
              await withExecution(
                { policy, control: join(workspace.state, 'control'), root: destination.path },
                execute,
              );
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
