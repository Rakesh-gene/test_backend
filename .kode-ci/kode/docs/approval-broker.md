# ADR-003: Native approval and user-input broker

Status: required design for all provider adapters. Recorded 6 November 2026.

## Decision

Kode owns the user-facing approval interaction during agent execution. Provider adapters capture native permission and user-input requests, a durable broker queues them, and the TUI presents the request and supported responses. Kode routes the user's decision back to the originating runtime through its native protocol/callback. It does not interpret a user clicking approve as completion of the requested operation.

Keep spec/proof approval, runtime permission requests, and ordinary clarifying questions as separate request kinds. Spec approval does not automatically approve shell commands, file writes, network access, or external tool actions. A permission denial is returned to the runtime so the agent can adapt within approved scope; it is not automatically a fatal failure of the feature.

## Provider adapter contract

| Provider | Native bridge | Kode responsibility |
| --- | --- | --- |
| Codex | App-server server-initiated JSON-RPC approval requests, plus structured user-input/elicitation requests where supported | Preserve request/thread/turn/item IDs, present native choices and scopes, send the exact protocol response, and observe resolution/action events |
| Claude | Agent SDK `canUseTool` callback for permission requests and supported user-question flow | Hold the callback pending, render the supplied tool details/questions, and return the correctly typed response to the waiting invocation |
| Copilot | SDK `onPermissionRequest` and `onUserInputRequest` handlers where exposed | Hold the handler pending, present supported permission/question choices, and return the SDK response to the matching session |

References: [Codex app-server approvals](https://learn.chatgpt.com/docs/app-server#approvals), [Claude approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input), [Copilot SDK compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility).

Adapters declare exact request kinds, grant scopes, cancellation, response acknowledgement, deadline, and reconnection support by tested version. Never assume identical choice names or session-grant semantics. Do not use permissive/bypass configurations merely to eliminate the user prompt. Native policy denials that cannot be overridden are surfaced as blocked actions with their reason, not rendered as an approval button that would be ineffective.

Unsupported interactive requests produce an explicit capability gap and controlled pause/failure. Do not let an invisible provider prompt wait indefinitely in a subprocess, scrape terminal text as the primary integration, or pretend an approval was delivered. Authentication/browser/device-code interaction can be surfaced as a separate action-required flow when exposed, rather than misrepresented as an ordinary tool permission.

## Request record and lifecycle

Persist the request before displaying it. Fields include Kode request ID, kind, provider and adapter version, connection epoch, native request/session/thread/turn/item/invocation identifiers as available, workspace/run/task/attempt/agent/root/worktree IDs, requested action and resource scope, native options, timestamps/deadline, request version, operation fingerprint, and redacted supporting details. Keep callback closures/live transport handles in memory, not serialized as though they survive restart.

Use lifecycle states `pending -> decision_recorded -> delivering -> resolved`, with `expired`, `cancelled`, `superseded`, and `delivery_unknown` outcomes where appropriate. Track the user's choice separately from native delivery status and subsequent tool execution status. Acknowledgement may be explicit (provider event) or adapter-observed callback completion; show which guarantee is available. Only native execution results update tool success/failure and proof evidence.

Deduplicate transport retries by provider connection/request identity, not only by command text. Two identical commands in different tasks remain separate requests. Use transactional expected-version decisions so two attached UIs cannot answer the same live request differently. Reject decisions for expired, replaced, completed, or disconnected invocations.

The operation fingerprint binds the displayed command/arguments, working directory, relevant file/diff or host/resource scope, and native grant choices. If the runtime changes the requested operation, supersede the old record and ask against the new details. Do not apply an old approval to a newly issued request without native protocol support and matching scope.

## Terminal interaction

All Kode approval UI described here is inside the interactive CLI/terminal interface. The inbox, request details, decision controls, and delivery/progress states are terminal views, not a separate web or desktop application.

Maintain a global approvals inbox with a count and per-agent/task badges. Each affected agent/tool becomes `awaiting approval` or `awaiting input`; independent ready agents can continue, while dependent tasks remain waiting. Keep tool/event streams processing while the TUI waits for a decision. An approval spanning several native actions shows its actual scope.

The request detail shows provider, agent, repo/worktree, command or proposed file diff, working directory, requested paths/hosts/permissions, reason, and available choices. Redact secrets and sanitize terminal escapes without concealing material scope. Provide an inspectable redacted artifact for large diffs/output, with clear truncation indicators.

Offer approve-once, deny, cancel, session/rule grant, or input selections only where supported and permitted. Broader grants require explicit selection and a visible scope; do not silently convert one-time approval into a session or persistent rule. Do not add a universal "approve everything" shortcut or have an agent answer its own approval. Kode's UI must never claim to bypass provider, organization, or OS restrictions.

Use deliberate keyboard selection and accessible text labels; a newly arriving request must not steal focus and turn a key intended for another pane into approval. Users can defer an item and handle others. For questions, preserve the provider-supplied options and supported free-text/schema fields. Return answers as structured data, not a vague follow-up prompt injected into the conversation.

After the user acts, show `sending decision`, then `approved/denied — delivered` when confirmed, then actual runtime progress or failure. If delivery is uncertain, show that explicitly and keep the task from being falsely marked resumed. Session-scoped grants display their owning session and lifetime; Kode cannot promise a provider-native persistent grant is revocable through its UI unless the adapter implements that capability.

## Pause, timeout, cancellation, and recovery

No user response is never approval. Respect native deadlines; an expired request is closed with the supported deny/cancel outcome or interruption, and a fresh request is required to proceed. Configure any native auto-resolution to avoid granting permission from elapsed time. Budget accounting distinguishes agent work from human-wait time while retaining provider session/resource limits.

Pausing a run prevents new task dispatch. A live native permission waiter can remain pending only when supported; otherwise cancel/interrupt it and mark its request obsolete. Cancelling a task/run resolves or invalidates its pending requests using native cancellation/denial and prevents late UI actions from restarting work. Dismissing the detail pane merely returns to the inbox; it is not an implicit decision.

On disconnect or restart, retain the audit and queue records, reconcile the provider session and transport, and rebind only native requests proven still pending with matching identity. A lost callback cannot be reconstructed from SQLite. If reattachment is unsupported, interrupt/recover the attempt and let the runtime issue a new request. Never replay previously recorded approvals into unrelated new sessions or repeat an operation to discover whether it already ran.

Persist decisions before sending them, but recognize that persistence and remote delivery are not an atomic transaction. Use provider-supported request IDs/idempotency or resolution checks where available. If a response may already have been consumed, reconcile events/results; otherwise mark delivery unknown and recover without promising exactly-once remote execution.

Headless/noninteractive runs emit structured pending-request events with defined exit/status behavior. They require an attached authorized control client or an explicit preconfigured policy for that exact scope; no blanket implicit approval is inferred from `--json`. If safe waiting is unsupported, interrupt cleanly and report the pending decision and recovery path.

## Audit, telemetry, and verification

Record requester, actor, request fingerprint/version, options, chosen scope, delivery state, native resolution, and eventual tool outcome in durable history. Do not place permission grants in shared agent memory as reusable authority; memory may reference the audit ID. Export correlated OpenTelemetry request/wait/decision/delivery spans and bounded metrics for pending counts, wait duration, denials, expirations, and delivery failures. Avoid raw sensitive tool payloads in telemetry.

Provider smoke/contract checks cover every required native request kind and valid response; simultaneous requests from different providers/agents; approve and deny; free-text/question routing; broad-scope visibility; duplicate events; double clicks; no UI focus stealing; timeout; native cancellation; disconnect before and after sending; lost callback restart; out-of-order resolution; changed command/diff; and an approved action that subsequently fails. Demonstrate on Windows, macOS, and Linux. A native action requiring approval must never execute before a valid decision or appear unblocked merely because the UI button was clicked.
