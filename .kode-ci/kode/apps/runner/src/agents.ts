import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CodexConnection } from '@kode/providers';
import { atomicJson, json, type Workspace } from '@kode/workspace';
import { redact, safeTerminal } from '@kode/contracts';
import { captureTraceContext, withTraceContext, type telemetry } from '@kode/observability';
import type { Store } from '@kode/storage';
import { ApprovalBroker } from './approvals.js';

const Start = z
  .object({
    root: z.string(),
    tree: z.string().uuid().optional(),
    prompt: z.string().min(1).max(32000),
    model: z.string().max(200).optional(),
    reasoning: z.string().max(40).optional(),
    sandbox: z.enum(['read-only', 'workspace-write']).default('read-only'),
    timeoutSeconds: z.number().int().min(10).max(3600).default(600),
  })
  .strict();
interface AgentRecord {
  id: string;
  epoch: string;
  root: string;
  tree?: string;
  cwd: string;
  status: string;
  model?: string;
  reasoning?: string;
  threadId?: string;
  turnId?: string;
  error?: string;
  response?: string;
  sandbox: string;
  traceContext: ReturnType<typeof captureTraceContext>;
}
export class Agents {
  private readonly secrets = Object.entries(process.env)
    .filter(([key]) => /secret|token|password|api_?key|connection[-_]?strings?/i.test(key))
    .map(([, value]) => value ?? '');
  private active = new Map<
    string,
    { connection: CodexConnection; done: Promise<void>; cancel: () => Promise<void> }
  >();
  readonly broker: ApprovalBroker;
  constructor(
    private workspace: Workspace,
    private store: Store,
    private otel: ReturnType<typeof telemetry>,
    private connect = () => new CodexConnection(),
  ) {
    this.broker = new ApprovalBroker(store, otel);
  }
  private file(id: string) {
    return join(this.workspace.state, 'agents', `${z.string().uuid().parse(id)}.json`);
  }
  async recover() {
    await this.broker.recover();
    const path = join(this.workspace.state, 'agents');
    for (const file of await readdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const record = await json<AgentRecord>(join(path, file));
      if (['running', 'awaiting approval'].includes(record.status)) {
        record.status = 'blocked';
        record.error =
          'Runner restarted; native session outcome is unknown. Pending approvals are not replayed.';
        await atomicJson(this.file(record.id), record);
      }
    }
  }
  async get(id: string) {
    return json<AgentRecord>(this.file(id));
  }
  async cancel(id: string) {
    const active = this.active.get(id);
    if (!active) throw new Error('Agent is not attached; inspect its durable status.');
    await active.cancel();
    return this.get(id);
  }
  async stop() {
    await Promise.allSettled([...this.active.values()].map((item) => item.cancel()));
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
  }
  async start(input: unknown) {
    const p = Start.parse(input),
      root = await this.workspace.root(p.root);
    const tree = p.tree ? await this.workspace.tree(p.tree) : undefined;
    if (tree && tree.rootId !== root.id) throw new Error('Task tree belongs to another root.');
    if (
      p.sandbox === 'workspace-write' &&
      (!tree || tree.access !== 'write' || root.access !== 'write')
    )
      throw new Error('Implementation requires an isolated writable task tree.');
    if (this.active.size >= 8) throw new Error('Agent concurrency limit reached.');
    const record: AgentRecord = {
      id: randomUUID(),
      epoch: randomUUID(),
      root: root.id,
      tree: tree?.id,
      cwd: tree?.path ?? root.path,
      status: 'running',
      model: p.model,
      reasoning: p.reasoning,
      sandbox: p.sandbox,
      traceContext: captureTraceContext(),
    };
    await atomicJson(this.file(record.id), record);
    let connection: CodexConnection;
    try {
      connection = this.connect();
    } catch (error) {
      record.status = 'blocked';
      record.error = String(redact(String(error), this.secrets)).slice(0, 2000);
      await atomicJson(this.file(record.id), record);
      throw new Error(`Agent ${record.id} blocked: ${record.error}`, { cause: error });
    }
    let finish!: () => void,
      complete = false,
      cancelled = false;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let serial = Promise.resolve();
    const emit = async (kind: 'task.updated' | 'tool.updated', data: Record<string, unknown>) => {
      await this.store.append({
        id: randomUUID(),
        kind,
        taskId: record.id,
        data: redact({ ...data, title: 'Codex assignment', agent: record.id, provider: 'codex' }),
      });
    };
    let persistence = Promise.resolve();
    const save = () => {
      const snapshot = structuredClone(record);
      const written = persistence.then(async () => {
        await atomicJson(this.file(record.id), snapshot);
        await emit('task.updated', { status: snapshot.status });
      });
      persistence = written.catch(() => {});
      return written;
    };
    const cancel = async () => {
      cancelled = true;
      await this.broker.invalidate(record.epoch, 'cancelled');
      if (record.threadId && record.turnId)
        await connection
          .request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId }, 3000)
          .catch(() => {});
      record.status = 'cancelled';
      await save();
      connection.close();
      finish();
    };
    const items = new Map<string, unknown>();
    connection.onRequest = async (method, raw, id) => {
      return withTraceContext(record.traceContext, async () => {
        if (cancelled || complete) throw new Error('Native assignment is no longer attached.');
        const params = z
          .object({ threadId: z.string(), turnId: z.string(), itemId: z.string() })
          .passthrough()
          .parse(raw);
        if (
          params.threadId !== record.threadId ||
          (record.turnId && params.turnId !== record.turnId)
        )
          throw new Error('Approval session identity mismatch.');
        const command = method === 'item/commandExecution/requestApproval',
          file = method === 'item/fileChange/requestApproval',
          permissions = method === 'item/permissions/requestApproval',
          question = method === 'item/tool/requestUserInput';
        if (!command && !file && !permissions && !question) {
          record.error = `Unsupported native request: ${method}`;
          void cancel();
          throw new Error(record.error);
        }
        if (
          String(params.command ?? '').length > 4096 ||
          String(params.reason ?? '').length > 2048
        ) {
          void cancel();
          throw new Error('Native approval exceeds display bounds; interrupted without a grant.');
        }
        if (question)
          z.array(
            z.object({
              id: z.string().min(1),
              header: z.string(),
              question: z.string(),
              isOther: z.boolean().optional(),
              isSecret: z.boolean().optional(),
              options: z
                .array(z.object({ label: z.string(), description: z.string() }))
                .nullable()
                .optional(),
            }),
          )
            .min(1)
            .max(10)
            .parse(params.questions);
        const details = JSON.stringify(
          redact({ ...params, item: items.get(params.itemId) }, this.secrets),
        );
        if (details.length > 8192) {
          void cancel();
          throw new Error(
            'Approval exceeds display bounds; native invocation interrupted without a grant.',
          );
        }
        record.status = 'awaiting approval';
        await save();
        if (cancelled || complete) throw new Error('Native assignment is no longer attached.');
        const decisions = Array.isArray(params.availableDecisions)
          ? params.availableDecisions
          : ['accept', 'decline', 'cancel'];
        const choices: ('accept' | 'decline' | 'cancel' | 'answer')[] = question
          ? ['answer', 'cancel']
          : permissions
            ? ['accept', 'decline', 'cancel']
            : (['accept', 'decline', 'cancel'].filter((choice) => decisions.includes(choice)) as (
                'accept' | 'decline' | 'cancel'
              )[]);
        const grant = (permissions ? params.permissions : params.additionalPermissions) as
          { fileSystem?: unknown; filesystem?: unknown } | undefined;
        const expandsFilesystem = Boolean(grant?.fileSystem || grant?.filesystem);
        const policyDenied =
          expandsFilesystem ||
          (file && (p.sandbox !== 'workspace-write' || Boolean(params.grantRoot)));
        if (policyDenied) {
          const accept = choices.indexOf('accept');
          if (accept >= 0) choices.splice(accept, 1);
        }
        return this.broker.request(
          {
            taskId: record.id,
            provider: 'codex',
            epoch: record.epoch,
            nativeId: JSON.stringify(id),
            threadId: params.threadId,
            turnId: params.turnId,
            itemId: params.itemId,
            kind: command ? 'command' : file ? 'file' : question ? 'question' : 'permissions',
            command: String(
              redact(
                String(
                  params.command ??
                    (file
                      ? 'Proposed file changes'
                      : question
                        ? 'Native user input'
                        : 'Additional permissions'),
                ),
                this.secrets,
              ),
            ).slice(0, 4096),
            cwd: String(params.cwd ?? record.cwd),
            reason:
              (policyDenied
                ? 'Filesystem expansion is outside the assignment policy; start a newly scoped assignment. '
                : '') + String(redact(String(params.reason ?? ''), this.secrets)).slice(0, 1900),
            details,
            choices,
            deadline:
              Date.now() +
              Math.min(
                p.timeoutSeconds * 1000,
                typeof params.autoResolutionMs === 'number'
                  ? Math.max(1, params.autoResolutionMs - 50)
                  : 300000,
              ),
          },
          (choice, answers) => {
            if (question) {
              if (choice === 'cancel') return { answers: {} };
              const shape = z
                .record(
                  z.string(),
                  z.object({ answers: z.array(z.string().max(4096)).min(1).max(10) }).strict(),
                )
                .parse(answers);
              const questions = z
                .array(
                  z.object({
                    id: z.string(),
                    options: z
                      .array(z.object({ label: z.string() }))
                      .nullable()
                      .optional(),
                    isOther: z.boolean().optional(),
                  }),
                )
                .parse(params.questions);
              if (
                Object.keys(shape).length !== questions.length ||
                questions.some(
                  (q) =>
                    !shape[q.id] ||
                    (q.options?.length &&
                      !q.isOther &&
                      shape[q.id]!.answers.some(
                        (answer) => !q.options!.some((option) => option.label === answer),
                      )),
                )
              )
                throw new Error('Answers do not match the native questions/options.');
              return { answers: shape };
            }
            if (permissions)
              return { permissions: choice === 'accept' ? params.permissions : {}, scope: 'turn' };
            return { decision: choice };
          },
        );
      });
    };
    connection.onNotification = (method, params) => {
      serial = serial
        .then(() =>
          withTraceContext(record.traceContext, async () => {
            const event = params as {
              threadId?: string;
              requestId?: number | string;
              item?: {
                id: string;
                type: string;
                status?: string;
                exitCode?: number;
                command?: string;
                aggregatedOutput?: string;
                text?: string;
              };
              turn?: { id: string; status: string };
            };
            if (event.threadId && event.threadId !== record.threadId) return;
            if (method === 'serverRequest/resolved' && event.requestId !== undefined) {
              await this.broker.resolved(record.epoch, JSON.stringify(event.requestId));
              if (!cancelled) record.status = 'running';
              await save();
            }
            if (method === 'item/started' && event.item) {
              items.set(event.item.id, event.item);
              if (items.size > 128) items.delete(items.keys().next().value!);
            }
            if (method === 'item/completed' && event.item) {
              const outcome =
                event.item.exitCode !== undefined && event.item.exitCode !== 0
                  ? 'failed'
                  : (event.item.status ?? 'completed');
              await this.broker.outcome(record.epoch, event.item.id, outcome);
              await emit('tool.updated', {
                phase: 'native',
                name: event.item.type,
                status: outcome,
                itemId: event.item.id,
                exitCode: event.item.exitCode,
                command: safeTerminal(String(redact(event.item.command ?? '', this.secrets))).slice(
                  0,
                  4096,
                ),
                output: safeTerminal(
                  String(redact(event.item.aggregatedOutput ?? '', this.secrets)),
                ).slice(-2048),
              });
              if (event.item.type === 'agentMessage' && event.item.text)
                record.response = safeTerminal(String(redact(event.item.text, this.secrets))).slice(
                  -16000,
                );
            }
            if (method === 'turn/completed' && event.turn) {
              complete = true;
              record.turnId = event.turn.id;
              record.status = cancelled
                ? 'cancelled'
                : event.turn.status === 'completed'
                  ? 'completed'
                  : event.turn.status;
              await save();
              finish();
            }
          }),
        )
        .catch(async (error) => {
          record.error = String(redact(String(error)));
          record.status = cancelled ? 'cancelled' : 'blocked';
          await save();
          finish();
        });
    };
    connection.onDisconnect = () => {
      if (!complete && !cancelled) {
        record.status = 'blocked';
        record.error = 'Codex disconnected; delivery/outcome must be reconciled.';
        void this.broker.invalidate(record.epoch, 'delivery_unknown').then(save).finally(finish);
      }
    };
    const done = withTraceContext(record.traceContext, () =>
      this.otel.operation('agent.codex', async () => {
        try {
          await connection.initialize({ experimentalApi: true });
          const catalog = (await connection.request('model/list', { limit: 100 })) as {
            data: {
              id: string;
              model: string;
              isDefault?: boolean;
              supportedReasoningEfforts?: { reasoningEffort: string }[];
            }[];
          };
          if (p.model) {
            const model = catalog.data.find(
              (item) => item.model === p.model || item.id === p.model,
            );
            if (
              !model ||
              (p.reasoning &&
                !model.supportedReasoningEfforts?.some((e) => e.reasoningEffort === p.reasoning))
            )
              throw new Error('Configured model/reasoning is not advertised by Codex.');
          }
          const thread = (await connection.request(
            'thread/start',
            {
              cwd: record.cwd,
              approvalPolicy: 'untrusted',
              approvalsReviewer: 'user',
              config: {
                default_permissions: 'kode-assignment',
                permissions: {
                  'kode-assignment': {
                    extends: p.sandbox === 'workspace-write' ? ':workspace' : ':read-only',
                    filesystem: {
                      ':root': 'read',
                      [join(this.workspace.state, 'control')]: 'deny',
                      [record.cwd]: p.sandbox === 'workspace-write' ? 'write' : 'read',
                    },
                    network: { enabled: false },
                  },
                },
              },
              ephemeral: false,
              ...(p.model ? { model: p.model } : {}),
            },
            60000,
          )) as {
            thread: { id: string };
            model?: string;
            activePermissionProfile?: { id: string };
          };
          if (thread.activePermissionProfile?.id !== 'kode-assignment')
            throw new Error(
              'Native runtime did not confirm the protected Kode permission profile. No assignment dispatched.',
            );
          if (p.reasoning) {
            const effective = catalog.data.find(
              (model) => model.model === thread.model || model.id === thread.model,
            );
            if (
              !effective?.supportedReasoningEfforts?.some(
                (effort) => effort.reasoningEffort === p.reasoning,
              )
            )
              throw new Error(
                'Requested reasoning is not advertised for the effective native model.',
              );
          }
          record.threadId = thread.thread.id;
          record.model = thread.model ?? p.model;
          record.traceContext = captureTraceContext();
          await save();
          const turn = (await connection.request('turn/start', {
            threadId: record.threadId,
            input: [{ type: 'text', text: p.prompt }],
            ...(p.reasoning ? { effort: p.reasoning } : {}),
          })) as { turn: { id: string } };
          record.turnId = turn.turn.id;
          await save();
          const timer = setTimeout(() => {
            void cancel();
          }, p.timeoutSeconds * 1000);
          timer.unref();
          try {
            await ended;
            await serial;
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          record.status = 'blocked';
          record.error = String(redact(String(error))).slice(0, 2000);
          await save();
        } finally {
          await this.broker.invalidate(record.epoch, 'delivery_unknown');
          complete = true;
          connection.close();
          this.active.delete(record.id);
        }
      }),
    );
    this.active.set(record.id, { connection, done, cancel });
    void done.catch(async (error) => {
      record.status = 'blocked';
      record.error = String(redact(String(error), this.secrets)).slice(0, 2000);
      this.active.delete(record.id);
      try {
        await atomicJson(this.file(record.id), record);
      } catch {
        this.otel.log('agent.persistence.failed', { agentId: record.id });
      }
    });
    return { id: record.id, status: record.status };
  }
}
