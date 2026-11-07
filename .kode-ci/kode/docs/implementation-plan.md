# Kode implementation phases and acceptance criteria

Status: implementation baseline for review; no phase is complete merely because this plan exists. Recorded 6 November 2026. Runtime baseline: Node.js 24.22.1, installed and activated through nvm during this session.

On 7 November 2026 the user authorized P02/P03 development while P00/P01 validation
gaps are deferred. See [deferred gaps](deferred-gaps.md). This authorizes development
past those gates without claiming the prerequisites were fully accepted.

The user subsequently selected Codex only for the current milestone. P00's live
provider gate now covers Codex; Claude/Copilot remain required for their future P10
adapters. This is an explicit temporary scope change, not evidence those providers passed.

## Scope and governing decisions

Deliver a rich interactive coding CLI on Windows, macOS, and Linux with multiple roots, XERJ/SQLite/Tree-sitter/SCIP context, approved specifications, executable proofs, native Codex/Claude/Copilot sessions, custom agents and model/reasoning selection, execution memory, dependency reuse, native approval relay, recovery, and OpenTelemetry.

Follow [product plan](kode-plan.md), [stack](tech-stack.md), [index/KG ADR](index-and-kg-decision.md), [refresh policy](index-refresh-policy.md), [memory/environments ADR](agent-memory-and-environments.md), and [approval ADR](approval-broker.md). This document supersedes the earlier coarse milestone numbering. Cross-platform behavior, rich terminal operation, and observability begin in the foundation, not a final cosmetic phase.

Calendar estimates are intentionally unset until P00 establishes actual integration and packaging effort. Phase exit criteria, not dates or lines of code, control progress. Scaffold/implementation work starts separately from approval of this planning document.

## Phase order

| Phase | Outcome | Prerequisites |
| --- | --- | --- |
| P00 | Toolchain and integration feasibility evidence | None |
| P01 | Durable runner, contracts, rich CLI shell, initial telemetry | P00 |
| P02 | Multi-root workspace and dirty-baseline isolation | P01 |
| P03 | Repo commands, services, and npm/NuGet environment reuse | P02 |
| P04 | Working XERJ retrieval and structural SQLite graph | P02; P03 for declared indexer/setup commands |
| P05 | Live refresh, SCIP enrichment, cross-repo contracts | P03, P04 |
| P06 | Spec/proof authoring and immutable approval gate | P04, P05 |
| P07 | Agent registry, shared execution memory, durable scheduling | P01, P02, P06 |
| P08 | Codex implementation and terminal-native approval round trip | P03, P05, P07 |
| P09 | Executable proof and first complete feature closure | P08 |
| P10 | Claude and Copilot parity through the same contracts | P09; live probes from P00 |
| P11 | Parallel agents, coordinated multi-repo implementation | P10 |
| P12 | Recovery, terminal quality, access boundaries, performance | P11; fault checks also required in earlier phases |
| P13 | Cross-platform packaging and release qualification | P12 |

This is a dependency order, not a requirement to delay all independent development. Command/environment work and basic extraction can proceed independently after their shared contracts exist. Provider-specific investigation starts in P00. A phase can be developed while a prerequisite gate is pending, but cannot be marked accepted until its prerequisite and own required criteria pass.

## Common acceptance and evidence rules

Each criterion has a stable `Pxx-Ayy` ID. Its record is `not_run`, `pass`, `fail`, `blocked`, or `not_applicable` with a reason. Every required criterion must pass to accept the phase. Missing credentials, unavailable OS runners, skipped scenarios, or an unsupported native feature are reported as gaps, not converted into success. A scope change needs a recorded decision and revised criteria.

Produce `docs/phase-reports/Pxx.md` during implementation with: implementation revision; criterion-to-test/scenario mapping; exact commands and exit statuses; OS/architecture/tool/SDK versions; input/environment hashes; artifact paths/checksums; known limitations; and each criterion's result. Keep large or sensitive artifacts outside version control. Never put real credentials or raw private source into a public report.

All phases run relevant typecheck, lint, build, and targeted tests. Test actual behavior and failure paths, not a mirror of internal implementation details. Captured provider events test normalization deterministically; live probes establish real provider behavior. PTY scenarios establish terminal interaction; a component snapshot alone cannot establish real keyboard, resize, or cancellation behavior.

Maintain OS CI from P01. At each platform-sensitive phase, run representative acceptance scenarios on Windows, macOS, and Linux x64; qualification for arm64 is explicit in P13. Unit tests running on three OSes do not substitute for command/process/terminal/install checks on those OSes. Tests involving providers must identify which OS/provider combinations were actually exercised.

## P00 — Toolchain and feasibility

### Deliverables

- Confirm Node 24.22.1 and npm 11.19.1 through nvm; pin this toolchain when scaffolding. Check Git, compiler-independent runtime assets, SQLite binding, Tree-sitter WASM, XERJ, and test tooling.
- Create bounded disposable probes for all three providers: session creation, one structured result, event stream, cancellation, model/reasoning discovery/configuration, and permission/user-input routing where exposed.
- Validate an Ink terminal prototype and local OTLP collection. Inventory native binary/platform and authentication/distribution constraints without changing the selected stack silently.

### Acceptance criteria

- **P00-A01:** A fresh shell resolves Node 24.22.1, npm 11.19.1, and Git. Commands/version outputs are recorded; Node 25 is not used to build the accepted baseline.
- **P00-A02:** A versioned compatibility matrix lists each provider's installation, authentication mode, session/resume/interrupt, native approval/question, model/reasoning, usage, and subagent capabilities, with observed evidence or an explicit gap.
- **P00-A03:** Each provider enabled in the current milestone completes a bounded live read-only assignment and a native permission request is approved and denied in controlled probes. The current milestone enables Codex; Claude/Copilot live gates remain deferred to P10. An unavailable enabled provider remains blocked and prevents accepting this gate.
- **P00-A04:** XERJ starts locally, ingests a fixture, returns a cited match, and shuts down only its own process. SQLite persists/reopens a fact and a WASM grammar parses the fixture.
- **P00-A05:** Ink displays selectable panes and handles terminal resize/exit; OTel emits a trace to a local receiver. Native assets have an explicit OS/architecture compatibility inventory.
- **P00-A06:** Record reference hardware, fixture sizes, tool versions, and proposed performance test harness. Document any required architecture amendment as an ADR rather than silently substitute a technology.

### Exit evidence

Probe transcripts, capability/asset matrix, terminal capture, sample OTLP payload, and toolchain versions. No private code or paid unbounded workload is needed for these probes.

## P01 — Contracts, persistence, runner, and rich CLI foundation

### Deliverables

- Scaffold npm workspaces/TypeScript packages from ADR-004 with a root package-lock.json, explicit build/typecheck/lint/test scripts, schemas, migrations, and versioned events/RPC.
- Build the workspace runner lease, platform IPC, client authentication, SQLite worker, artifact IDs, and event replay.
- Build Ink layout, navigation, task/agent lanes, event/tool detail, and approval/proof/context pane contracts. Use labeled fixture events until real services land.
- Add initial OTel/Pino wiring and Windows/macOS/Linux CI.

### Acceptance criteria

- **P01-A01:** Clean install, typecheck, lint, build, and targeted tests succeed on the three OS families with the pinned toolchain.
- **P01-A02:** `kode`, `kode --help`, and a JSON diagnostic command work. Interactive mode supports keyboard navigation, narrow/wide resize, and clean terminal restoration; JSON output contains only documented machine-readable output.
- **P01-A03:** Two clients attach to the same workspace runner; a competing runner cannot acquire its lease. An unauthorized local client cannot issue control RPCs.
- **P01-A04:** Durable events survive process restart and replay in sequence without duplicate visible tasks. Corrupt/unsupported schema versions fail with actionable diagnostics, and failed migrations leave recoverable state.
- **P01-A05:** A deliberately slow SQLite query does not block terminal input or runner approval-message handling. Large/invalid RPC messages are rejected within configured limits.
- **P01-A06:** A command's logs and trace share correlation IDs. Turning off the collector preserves durable events and responsive interaction. Content redaction occurs before log/export sinks.

### Exit evidence

Three-OS CI results, PTY navigation/resize recording, IPC/lease/replay tests, migration recovery output, and correlated sample telemetry. The rich shell is working functionality even while its event data is initially simulated.

## P02 — Multiple roots and preserved local state

### Deliverables

- Implement init, folder add/list/remove, root permissions, canonical path identity, and repository discovery.
- Capture HEAD plus current permitted file contents, staged/unstaged provenance, and untracked additions/deletions.
- Create task worktrees from captured input manifests and a single-writer snapshot/patch mode for ordinary folders.

### Acceptance criteria

- **P02-A01:** Register a backend repo, frontend repo, and read-only ordinary folder; reject ambiguous duplicates and resolve spaces/Unicode, nested repos, symlinks, and Windows case variants correctly.
- **P02-A02:** With staged and unstaged changes in the same file plus an untracked file and deletion, the captured manifest matches disk bytes. Task worktree content matches that manifest, not merely HEAD.
- **P02-A03:** Snapshot/worktree creation does not modify source files, staging, or user history. Before/after source hashes and staging status confirm preservation.
- **P02-A04:** Two isolated worktrees editing the same path remain independent. A root declared read-only cannot be granted write scope by an ordinary agent assignment; enforce actual supported execution boundaries and report sandbox limitations.
- **P02-A05:** Changes racing baseline capture trigger verification/retry; unresolved collisions/conflicts produce explicit blocked state. Unborn/detached-head repos and non-Git folders have defined handling.
- **P02-A06:** Removing a registered root unregisters it without deleting source. Cleanup removes only owned, unleased worktrees/artifacts and preserves data referenced by accepted evidence.

### Exit evidence

Fixture manifests, content/staging comparisons, isolated edit results, platform path tests, and ordinary-folder recovery tests.

## P03 — Repo commands, services, and reusable dependencies

### Deliverables

- Publish `kode.yaml` schema; implement repo init/inspect and named command execution with structured output, timeouts, and cancellation.
- Add service dependencies, readiness probes, assigned ports, setup/fixture/cleanup, and run-owned process teardown.
- Implement environment discovery/fingerprints/receipts/leases with npm and NuGet PackageReference adapters. Follow declared project tools; Kode's npm choice does not change managed repos.

### Acceptance criteria

- **P03-A01:** Valid Node and .NET manifests run declared commands from the correct worktree. Invalid commands/schema paths and missing tools return actionable errors; arguments containing spaces/metacharacters remain literal.
- **P03-A02:** An already healthy compatible installation is reused with zero automatic install-command invocations. Switching provider/agent against the same environment does not prepare it again.
- **P03-A03:** A new worktree uses a validated compatible installation snapshot or existing manager caches. Offline preparation succeeds when all necessary packages are cached, and reports missing content when incomplete; no claim of zero materialization cost is made.
- **P03-A04:** Changing lockfile, SDK/native ABI, manager flags, or relevant configuration invalidates compatibility. A user-owned installation is never erased/modified to make a cache hit possible; writable links cannot leak changes across worktrees.
- **P03-A05:** Concurrent requests for one target/fingerprint perform at most one preparation. Crash mid-install leaves an unready receipt and recoverable state, not a false cache hit. .NET worktrees reuse package caches but have independent restore metadata/output.
- **P03-A06:** Services start in dependency order and await readiness. Port collision, readiness timeout, failed fixture setup, cancellation, and child-process cleanup are exercised on all three OS families; unrelated processes survive.
- **P03-A07:** Terminal and telemetry report command status, environment reuse source, fingerprint, and invalidation reason. Secrets do not appear in receipts or captured command output metadata.

### Exit evidence

Instrumented install counts, cache hit/miss/invalidated receipts, offline cases, service lifecycle logs, Node/.NET results, and source-installation preservation checks.

## P04 — Search index and structural graph

### Deliverables

- Implement generation manifests, SQLite typed facts, Tree-sitter WASM extraction for TS/JS/Python, bounded fallback text chunks, and XERJ ingestion/publication.
- Add symbol/path search, BM25 retrieval, bounded graph expansion, citations, coverage, and a context-inspection terminal pane.
- Expose scoped read-oriented context MCP tools.

### Acceptance criteria

- **P04-A01:** A versioned fixture with at least 30 declarations across TS/JS/Python returns every expected supported definition with the correct root, path, range, and source hash. Unsupported syntax/languages are labeled text-only or partial.
- **P04-A02:** A fixed query set of at least 20 symbol/path/text queries places the annotated relevant result in the top five for at least 18 queries. Store query expectations and ranking results; this is a target, not a claimed measured result.
- **P04-A03:** Search chunks and graph facts share a published generation. Killing ingestion between the two stores exposes neither a mixed generation nor incomplete data as current.
- **P04-A04:** Deletes/renames remove obsolete facts/chunks; repeated unchanged indexing reuses extraction and produces equivalent results. Cyclic graph traversal terminates at explicit bounds and reports truncation.
- **P04-A05:** Context MCP queries respect root/worktree read scope and response budgets. The TUI displays citations, generation, precision, indexing state, and coverage.
- **P04-A06:** XERJ unavailability produces explicit degraded direct inspection/recovery; no automatic external embedding/sharing/feedback calls are enabled. Rebuild preserves approvals, memory, source, and proof history.

### Exit evidence

Curated source/query fixtures, search/graph outputs, generation crash test, access/budget tests, and inspectable terminal context results.

## P05 — Freshness, Git lifecycle, semantics, and contracts

### Deliverables

- Implement the refresh policy with file events, tool/command notifications, Git polling, hash reconciliation, and synchronous workflow barriers.
- Add SCIP ingestion for supported TS/JS and Python project fixtures, separate semantic freshness, and schema/package/configuration-backed cross-repo links.
- Notify active consumers when a context pack becomes invalid.

### Acceptance criteria

- **P05-A01:** Staged/unstaged/untracked edits, external editor saves, and provider shell writes appear in the next current-context generation; removed data never remains current merely because an edit hook was missed.
- **P05-A02:** Exercise commit/amend, pull fast-forward/merge/rebase, failed/conflicted pull, switch, reset/restore, and stash apply/pop. Reconcile actual disk content and remaining local changes; fetch/push with unchanged local content performs no unnecessary source reparse.
- **P05-A03:** Lost watcher events/overflow and a branch switch while indexing lead to reconciliation. A forced query barrier waits for a coherent generation or returns an explicit pending/error state; it cannot silently return stale current context.
- **P05-A04:** Two agents see different generations for different worktrees. An input hash changing between retrieval and edit forces context revalidation; a subscribed agent sees invalidation before its next controlled dependent action.
- **P05-A05:** Curated SCIP fixtures resolve all annotated supported definitions/references, while unsupported/dynamic cases remain unresolved/partial. After relevant edits, stale semantic edges disappear from current precise results until rebuilt.
- **P05-A06:** A package-version fixture and API/schema fixture create expected cross-repo edges. Ambiguous versions or equal names without evidence do not create false precise links. Dependent contracts refresh after source/schema/config changes.
- **P05-A07:** Context/spec/proof barriers resolve all participating root generations. A pure metadata commit can reuse equivalent content; a code-changing pull invalidates relevant context and proof eligibility.

### Exit evidence

Git-event acceptance matrix, stale-query/racing-change recordings, semantic precision/coverage report, cross-repo contract assertions, and refresh telemetry.

## P06 — Spec-driven planning and approval

### Deliverables

- Implement feature intake, source-backed research, editable spec/design artifacts, stable requirement IDs, preliminary task DAG, and proof plan.
- Add terminal spec/diff review and approval records bound to behavior, scope, and proof assertions.
- Validate dependency cycles, unresolved questions, root scope, and acceptance-to-proof mappings before dispatch.

This phase establishes the authoring/validation/approval contracts using supplied fixture drafts or manually edited drafts. P08 connects live Codex research/spec authoring; P09 proves the automatic description-to-closure flow. This avoids making the artifact/approval gate depend on implementation execution before the provider adapter is ready.

### Acceptance criteria

- **P06-A01:** Given a feature description and supplied/edited draft on the fixture workspace, validate and persist a spec covering goals/non-goals, current behavior with valid citations, proposed behavior, edge cases, affected roots/contracts, acceptance criteria, and applicable migration/rollback. Unresolved requirements remain explicit. Automatic drafting is a P08/P09 gate, not claimed from fixture drafts here.
- **P06-A02:** Every acceptance criterion maps to an observable assertion and suitable integration/UI/CLI proof method, command, required environment, and evidence type. A build-only check cannot satisfy a criterion requiring behavior verification.
- **P06-A03:** The preliminary task graph is acyclic, maps every task to requirements/roots/outputs, and exposes ordering/contracts for review.
- **P06-A04:** Implementation dispatch is refused before approval. Approval records exact artifact hashes and actor/time; changing behavior, approved scope, or materially weakening proof assertions invalidates approval.
- **P06-A05:** The CLI shows a readable spec and revision diff and supports approve/reject/revise. Noninteractive absence of an answer never grants approval.
- **P06-A06:** A stale citation or changed local input baseline triggers research reconciliation. Agent-generated assumptions cannot silently become approved requirements or override native runtime permissions.

### Exit evidence

One complete proposed spec/proof/task bundle, approval and invalidation records, refusal-to-dispatch tests, and PTY review/decision capture.

## P07 — Agent definitions, execution memory, and scheduling

### Deliverables

- Add agent registry/bundles, prompts, skills, capability cards, root/tool policy, model/reasoning selection and override provenance.
- Build private/task/run/workspace memory scopes, versioned records, subscriptions, checkpoints, and handoffs.
- Implement persisted task DAG scheduling, attempts, concurrency/resource limits, bounded repair policies, and environment prerequisites.

### Acceptance criteria

- **P07-A01:** Add/list/inspect a custom agent; malformed schemas, escaped bundle paths, unknown required capabilities, and incompatible model/reasoning combinations fail clearly. Effective settings and precedence are inspectable and pinned per attempt.
- **P07-A02:** Replacement agents receive the approved spec, scoped current context, accepted shared decisions, latest checkpoint, known failures, and environment receipt within a defined pack budget. A provider change does not lose task state or reinstall dependencies automatically.
- **P07-A03:** Two agents exchange a versioned contract/finding and receive relevant updates. Concurrent conflicting writes are detected; stale findings and speculative notes cannot override accepted decisions/proof outcomes.
- **P07-A04:** Private/other-root memory is excluded from unauthorized reads, search, and subscriptions. Compaction/restart restores durable checkpoints; secrets are excluded from default memory/export paths.
- **P07-A05:** Only dependency-ready tasks dispatch; failed prerequisites hold dependents, concurrency/delegation limits are enforced, and exhausted retries/budgets produce explicit state. Restart does not duplicate completed task transitions.
- **P07-A06:** Pending memory/environment/agent statuses appear live in the terminal with correlated task/attempt IDs. Simulation fixtures are labeled and are not counted as live provider proof.

### Exit evidence

Agent bundle examples, resolved configurations, memory conflict/access/handoff tests, scheduler transition/fault tests, and terminal interaction recordings.

## P08 — Codex execution and native approval broker

### Deliverables

- Implement Codex app-server lifecycle, event normalization, session persistence, model/reasoning selection, interruption, and capability checks.
- Connect live read-only research/spec-author assignments to P06 so feature descriptions generate source-backed drafts for user review without implementation writes.
- Wire context/memory/environment services to the live assignment.
- Implement the durable native permission/question broker and terminal inbox, correlation, supported scopes, and delivery state.

### Acceptance criteria

- **P08-A01:** A live read-only Codex research/spec assignment turns a feature description into a cited draft that passes P06 validation; after user approval, a live implementation assignment makes the small approved change in the intended worktree using its configured model/reasoning. Record native session IDs and observable tools/artifacts; do not claim unknown provider-internal data.
- **P08-A02:** A real permission request appears in the CLI with originating task/agent/provider, command/diff, root/cwd, reason, requested resources, and native-supported choices. The action does not execute before the applicable decision.
- **P08-A03:** Approve, deny, and supported cancel/question responses reach the exact waiting invocation. CLI status distinguishes recorded decision, delivery/resolution, and actual action outcome; an approved failing command is shown as failed.
- **P08-A04:** Concurrent requests route independently; duplicate events/double-clicks cannot deliver conflicting answers. Incoming prompts do not steal focus or turn an unrelated keypress into approval.
- **P08-A05:** Timeout, disconnect before/after delivery, obsolete requests, pause/cancel, and runner restart either rebind a confirmed live request or recover with a fresh request. No approval is inferred from silence or replayed into an unrelated session.
- **P08-A06:** Native policy rejection is surfaced with its reason, without a fake override. Structured headless mode reports pending decisions safely. Memory references approval audits without acquiring grant authority.
- **P08-A07:** Pause/resume/cancel retain durable task state and preserve user files/owned services as specified. The TUI shows real agent/tool/context/approval activity and corresponding OTel data.

### Exit evidence

Sanitized live Codex traces, approve/deny/question recordings, stale/duplicate/delivery-uncertain fault cases, and the resulting source diff with exact task/environment provenance.

## P09 — Executable proof and first complete vertical slice

### Deliverables

- Implement proof selection/execution, report dialect validation, stable scenario/assertion mapping, fixtures/services, and artifact manifests.
- Integrate a verifier assignment, fresh-snapshot barriers, requirement coverage matrix, bounded repair loop, and closure gate.
- Complete an API/client fixture feature from description through approval, implementation, integration, proof, and closure. Work may be sequential here; parallel collaboration follows in P11.

### Acceptance criteria

- **P09-A01:** Complete one feature spanning API and browser behavior using declared repo commands and real participating services. Capture integration assertions and Playwright browser assertions/traces; mocked-only downstream behavior cannot satisfy a real-integration criterion.
- **P09-A02:** Each required acceptance criterion maps to executed assertions, scenario IDs, result/report, spec/proof/source/environment fingerprints, artifact checksums, and exit status. Prose success or screenshots alone cannot pass the gate.
- **P09-A03:** Demonstrate a behavior regression that fails against the baseline and passes after implementation. Review assertions against the approved requirement, including at least one negative-path scenario.
- **P09-A04:** Required missing, failed, skipped, blocked, stale, or flaky proof prevents successful closure. Unsupported report/scenario IDs, missing artifacts, and a success exit code with failed assertions are rejected.
- **P09-A05:** Edits to implementation/test/fixture/command/dependency inputs during or after proof invalidate affected evidence. Restart preserves evidence history; a later pure metadata commit records content equivalence rather than forging a new execution.
- **P09-A06:** A deliberate failure enters bounded repair then reruns required proofs; exhausted repair limits stop clearly. Material assertion weakening or scope change requires reapproval.
- **P09-A07:** The rich CLI displays acceptance coverage, current proof, failures, diffs, and artifact links. Closure report distinguishes original local edits, Kode changes, passed behavior, and any unresolved limitations.

### Exit evidence

First complete spec-to-proof feature bundle, red/green regression evidence, integrated revisions/manifests, native approval history, and terminal recording. This is the first internal usable milestone, not the full three-provider release.

## P10 — Claude and Copilot provider parity

### Deliverables

- Implement the Claude Agent SDK and Copilot SDK adapters against the shared session/task/approval contracts.
- Complete per-provider model/reasoning validation, native input/permissions, capability reporting, interruption, and recovery limits.
- Add supported native subagent controls without bypassing global delegation/resource accounting.

### Acceptance criteria

- **P10-A01:** The bounded feature workflow executes independently through Codex, Claude, and Copilot on the shared fixture and produces the same required behavioral proof outcomes; code need not be textually identical.
- **P10-A02:** For each provider, demonstrate live approve/deny and supported question/cancel interactions through the CLI, plus adapter-specific timeout/reconnect limitations. Recorded fixtures alone cannot pass live parity.
- **P10-A03:** Choose independent valid model/reasoning configurations for implementer/reviewer assignments. Reject unsupported explicit settings without silent fallback; record any deliberately selected fallback and effective settings when observable.
- **P10-A04:** Switching a task to another provider uses a portable checkpoint/context/memory handoff, creates the necessary new native session, and preserves exact approved scope and environment reuse.
- **P10-A05:** Provider availability/authentication/capability failures are explicit; native-session or token/cost unknowns are not fabricated. SDK startup output does not corrupt TUI/JSON output.
- **P10-A06:** Native subagent delegation is bounded/accounted where observable; required per-child controls that cannot be enforced cause separate Kode assignments or a reported unsupported capability. Published provider/OS coverage has no unmarked holes.

### Exit evidence

Three-provider live acceptance matrix, normalized and native traces, model/reasoning validation results, approval round trips, and provider-switch handoff evidence.

## P11 — Parallel collaboration and coordinated multi-repo delivery

### Deliverables

- Schedule independent agent assignments in isolated worktrees with shared decisions/contracts and explicit ownership.
- Integrate dependency outputs in order, detect overlaps, refresh impacted context, and coordinate API/client/schema changes.
- Keep global terminal activity/approval/memory/proof views coherent under concurrent streams.

### Acceptance criteria

- **P11-A01:** Run at least three concurrent assignments across two repositories using at least two providers. Verify independent source state and correct context generations; one agent's work is not silently visible to another before handoff/integration.
- **P11-A02:** Demonstrate an API contract published through shared memory, consumed by the client agent, and verified by an integration/browser proof. Dependency tasks wait for actual required artifacts/snapshots.
- **P11-A03:** Deliberately conflicting edits trigger integration handling, preserving both histories and preventing premature closure. Combined tests catch a failure not exposed by isolated task checks.
- **P11-A04:** A blocked approval suspends only affected/dependent work; other eligible agents and their approvals continue. Approvals cannot cross-route between providers or duplicate identical command text.
- **P11-A05:** Environment preparation is reused/serialized correctly; services use owned ports and stop cleanly. There are no cross-worktree dependency writes or unbounded recursive native/Kode delegation.
- **P11-A06:** The final multi-repo closure report lists all repo revisions/content generations, approved contracts, decisions, integration changes, and actual proof evidence. It explicitly avoids promising an atomic commit across repos.

### Exit evidence

Concurrent terminal capture, shared-memory/contract history, worktree isolation assertions, conflict resolution and combined-failure tests, and final cross-repo proof report.

## P12 — Recovery, rich-terminal quality, boundaries, and performance

### Deliverables

- Exercise crash/reconnect/retry behavior through the complete pipeline; refine terminal accessibility and high-volume event handling.
- Audit scoped roots/memory/MCP/IPC, command/terminal sanitization, credential redaction, cache ownership, and retention.
- Run reproducible performance and long-run tests with traceable budgets.

### Acceptance criteria

- **P12-A01:** Kill runner/provider/indexer during dispatch, native approval wait/delivery, environment preparation, generation publication, integration, and proof. Resume reconciles native state and does not replay uncertain external actions or falsely complete tasks.
- **P12-A02:** No action requiring a live approval executes from silence, stale decisions, another task's grant, or agent-generated shared memory. Unauthorized local clients and root/memory/tool scopes are denied at enforced boundaries; documented OS/provider sandbox limitations remain visible.
- **P12-A03:** PTY scenarios cover narrow/wide resize, focus/navigation/search/filter, approval deferral, Unicode/wrapped output, ANSI escape sanitization, reduced-motion/linear modes, and terminal restoration on clean and failed exits.
- **P12-A04:** Collector outage/backpressure and large output preserve durable memory/events/proofs. Export queues stay bounded and loss counters are visible; sensitive seed values do not appear in configured redacted logs/telemetry artifacts.
- **P12-A05:** On the recorded reference machine, replay five agents at 200 normalized events/second with 10,000 retained history events for 10 minutes. Key-to-visible-response p95 stays at or below 250 ms; no lost approval/state events, and retained UI buffers do not grow with total log length beyond configured caps.
- **P12-A06:** On a 1,000-source-file fixture of at most 10 MiB on local SSD with no competing build/model load, p95 save-to-published syntax/search refresh across 20 single-file edits is at most 5 seconds; warm context-query p95 is at most 1 second across 100 queries. Record semantic/indexer time separately. These are initial acceptance targets, not observed claims; changes need a documented budget decision.
- **P12-A07:** Cold index/build RAM/disk/latency measurements for the small repo, representative monorepo, and connected pair are recorded. Configured time/node/token/output bounds terminate work with explicit partial results rather than hangs; benchmark correctness gates still pass.

### Exit evidence

Fault-injection matrix, access/redaction checks, PTY captures, sustained-load measurements, indexing/query distributions, and documented remaining platform/capability limitations.

## P13 — Packaging and release qualification

### Deliverables

- Build the npm CLI package and platform archives with tested runtime/native/WASM/schema/migration assets and version checksums/licenses.
- Provide onboarding, repo/agent/proof manifest documentation, troubleshooting, upgrade/backup/recovery, and support matrix.
- Qualify x64 and arm64 targets; clearly mark any unqualified target as unsupported rather than imply universal binaries.

### Acceptance criteria

- **P13-A01:** Clean Windows/macOS/Linux x64 machines install and launch the npm package under the supported runtime and the runtime-included archive without requiring a compiler for ordinary installation. WSL/Docker is not required to run Kode.
- **P13-A02:** Each advertised arm64 target passes the same native asset/startup/core workflow checks. A missing target cannot be advertised as supported; partial architecture coverage is recorded as an explicit release gap/scope decision.
- **P13-A03:** Packaged workers, SQLite binding, WASM grammars, migrations, schemas, provider adapters, and XERJ paths resolve after relocation into a directory containing spaces/Unicode. Asset checksums and version diagnostics are inspectable.
- **P13-A04:** An existing workspace upgrades with backup/migrations; interruption can recover without losing source, spec approvals, shared memory, or evidence. Uninstall/cache cleanup does not delete user repos or package caches.
- **P13-A05:** On each advertised OS family, execute the two-repo approved-spec-to-proof reference workflow with the rich CLI, native approval interaction, dirty-baseline context, shared memory, dependency reuse, and OTel export. Run bounded live provider acceptance for all advertised provider/OS combinations with credentials available; missing live combinations remain gaps.
- **P13-A06:** Documentation lets a new user add a repo, configure commands, select an agent/model/reasoning value, approve a spec/runtime request, inspect proof, and resume interruption. No required step depends on an undisclosed developer-local path or secret.
- **P13-A07:** All required criteria from P00–P13 are mapped to retained evidence, relevant regressions pass, and no unresolved issue can bypass approval, mix worktree generations, lose user files, corrupt environment reuse, or falsely declare proof-backed closure.

### Exit evidence

Signed/checksummed release outputs where configured, packaged-install matrix, migration recovery results, end-user walkthrough, complete criterion ledger, and published limitations. This is the complete initial release gate.

## Starting implementation

Begin with P00 and P01: pin the installed Node version, choose compatible dependency versions, establish three-OS CI, and prove the runner/terminal/persistence boundaries. Implement production behavior incrementally through the phases; keep simulated provider data visibly labeled. Revisit scheduling/dates after these first gates, retaining the agreed functional scope and acceptance criteria.
