import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024;
export const eventKinds = [
  'runner.started',
  'task.updated',
  'tool.updated',
  'approval.requested',
  'approval.resolved',
  'approval.updated',
  'context.updated',
  'proof.updated',
] as const;
export const EventInput = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(eventKinds),
    taskId: z.string().max(160).optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export const StoredEvent = EventInput.extend({
  seq: z.number().int().positive(),
  time: z.string(),
});
export type KodeEvent = z.infer<typeof StoredEvent>;
export const TraceContext = z
  .object({
    traceparent: z.string().max(512).optional(),
    tracestate: z.string().max(512).optional(),
  })
  .strict();
export const RpcRequest = z
  .object({
    jsonrpc: z.literal('2.0'),
    version: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1).max(100),
    token: z.string().min(32).max(256),
    traceContext: TraceContext.optional(),
    method: z.enum([
      'ping',
      'status',
      'events.list',
      'fixture.load',
      'approval.respond',
      'test.slowQuery',
      'shutdown',
      'workspace.init',
      'folder.add',
      'folder.list',
      'folder.remove',
      'baseline.capture',
      'tree.create',
      'tree.cleanup',
      'tree.retain',
      'repo.init',
      'repo.inspect',
      'env.inspect',
      'job.start',
      'execution.configure',
      'execution.inspect',
      'job.get',
      'job.cancel',
      'agent.start',
      'agent.get',
      'agent.cancel',
      'approval.list',
      'approval.get',
      'approval.decide',
    ]),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Request = z.infer<typeof RpcRequest>;
export const RpcResponse = z
  .object({
    jsonrpc: z.literal('2.0'),
    version: z.literal(PROTOCOL_VERSION),
    id: z.union([z.string(), z.number(), z.null()]),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
        data: z.object({ code: z.string() }).optional(),
      })
      .optional(),
  })
  .strict();
export type Response = z.infer<typeof RpcResponse>;
export const NativeApproval = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  provider: z.literal('codex'),
  epoch: z.string().uuid(),
  nativeId: z.string().max(200),
  threadId: z.string().max(200),
  turnId: z.string().max(200),
  itemId: z.string().max(200),
  kind: z.enum(['command', 'file', 'question', 'permissions']),
  command: z.string().max(4096),
  cwd: z.string().max(4096),
  reason: z.string().max(2048),
  details: z.string().max(8192),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  choices: z.array(z.enum(['accept', 'decline', 'cancel', 'answer'])).max(4),
  state: z.enum([
    'pending',
    'decision_recorded',
    'delivering',
    'resolved',
    'expired',
    'cancelled',
    'superseded',
    'delivery_unknown',
  ]),
  version: z.number().int().positive(),
  deadline: z.number(),
  decision: z.string().optional(),
  delivery: z.string().optional(),
  outcome: z.string().optional(),
  traceContext: TraceContext.optional(),
  fixture: z.literal(false),
});
export type NativeApprovalRecord = z.infer<typeof NativeApproval>;
export const ReplayParams = z
  .object({
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();
export const DecisionParams = z
  .object({
    requestId: z.string().uuid(),
    decision: z.enum(['approve', 'deny']),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export interface TaskView {
  id: string;
  title: string;
  agent: string;
  status: string;
  provider: string;
}
export interface ApprovalView {
  id: string;
  taskId: string;
  command: string;
  state: string;
  version: number;
  fixture: boolean;
  native?: NativeApprovalRecord;
}
export interface ViewState {
  cursor: number;
  tasks: Map<string, TaskView>;
  approvals: Map<string, ApprovalView>;
  events: KodeEvent[];
}
export function emptyView(): ViewState {
  return { cursor: 0, tasks: new Map(), approvals: new Map(), events: [] };
}
export function projectEvent(state: ViewState, event: KodeEvent): ViewState {
  if (event.seq <= state.cursor) return state;
  state.cursor = event.seq;
  state.events = [...state.events.slice(-199), event];
  if (event.kind === 'approval.updated') {
    const parsed = NativeApproval.safeParse(event.data);
    if (parsed.success) {
      const record = parsed.data;
      state.approvals.set(record.id, {
        id: record.id,
        taskId: record.taskId,
        command: record.command,
        state: record.state,
        version: record.version,
        fixture: false,
        native: record,
      });
    }
  }
  if (event.kind === 'task.updated' && event.taskId) {
    const parsed = z
      .object({ title: z.string(), agent: z.string(), status: z.string(), provider: z.string() })
      .safeParse(event.data);
    if (parsed.success) state.tasks.set(event.taskId, { id: event.taskId, ...parsed.data });
  }
  if (event.kind === 'approval.requested') {
    const parsed = z
      .object({
        id: z.string(),
        taskId: z.string(),
        command: z.string(),
        state: z.string(),
        version: z.number(),
        fixture: z.boolean(),
      })
      .safeParse(event.data);
    if (parsed.success) state.approvals.set(parsed.data.id, parsed.data);
  }
  if (event.kind === 'approval.resolved' && typeof event.data.requestId === 'string') {
    const prior = state.approvals.get(event.data.requestId);
    if (prior)
      state.approvals.set(prior.id, {
        ...prior,
        state: String(event.data.decision),
        version: prior.version + 1,
      });
    if (prior && event.data.fixture === true) {
      const task = state.tasks.get(prior.taskId);
      if (task)
        state.tasks.set(task.id, {
          ...task,
          status: `fixture ${String(event.data.decision)} recorded; no execution`,
        });
    }
  }
  return state;
}

const sensitiveKey =
  /authorization|password|secret|token|api[-_]?key|cookie|connection[-_]?strings?/i;
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value.replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,})\b/g,
      '[REDACTED]',
    );
    for (const secret of secrets.filter((s) => s.length >= 4))
      text = text.split(secret).join('[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? '[REDACTED]' : redact(item, secrets),
      ]),
    );
  return value;
}

export function safeTerminal(text: string): string {
  // Terminal control bytes are the input this sanitizer intentionally removes.
  /* eslint-disable no-control-regex */
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  /* eslint-enable no-control-regex */
}
