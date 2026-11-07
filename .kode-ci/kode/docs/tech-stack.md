# ADR-004: Kode technology stack

Status: selected for implementation. Recorded 6 November 2026. Exact dependency versions will be pinned together during scaffolding and validated in the OS/architecture matrix; selecting a library is not a claim that integration checks have passed.

P02/P03 refine local resource-descriptor persistence through [ADR-005](metadata-persistence-decision.md);
runner events/audits continue to use SQLite. See phase reports for observed evidence.

## Selected stack

| Layer | Selection | Purpose |
| --- | --- | --- |
| Language | TypeScript, strict mode, ESM | Shared typed contracts across runtime, TUI, adapters, and tests |
| Runtime | Node.js 24.22.1 LTS, pinned | Installed through nvm; baseline for SDK and native-module compatibility |
| Repository tooling | npm workspaces, npm 11.19.1 baseline | Multi-package development and reproducible resolution through `package-lock.json` |
| Build | TypeScript compiler (`tsc`), project references | Emit ESM and declarations; preserve native modules, worker entry points, and SDK boundaries |
| Rich terminal interface | React + Ink | Interactive panels, focus/navigation, approvals, tool streams, context/memory inspection, and proof views |
| Command routing | Commander | Commands, flags, help, JSON/headless modes, and defined exits |
| Configuration | `yaml` parser + Zod 4, generated JSON Schema | Validate repo/agent/spec/proof contracts and provide editor support |
| Persistence | SQLite via `better-sqlite3`, versioned SQL migrations | Run/task state, events, memory, approval audit, environment receipts, typed KG facts |
| Artifact storage | Local filesystem, Node SHA-256 content hashes | Immutable evidence, logs, screenshots, traces, and captured input manifests |
| Workflow orchestration | Kode-owned typed state machines, dependency DAG, SQLite-backed queue/leases | Deterministic scheduling, bounded concurrency/retries, checkpoints, and recovery |
| Code/document retrieval | XERJ managed local process | Agreed retrieval backend; version/checksum pinned |
| Structural extraction | Tree-sitter WASM runtime (`web-tree-sitter`) and pinned grammar assets | Incremental code structure/chunk extraction in workers |
| Semantic enrichment | SCIP format and language-specific indexers | Precise symbol definitions/references where supported |
| Agent tools | Official MCP TypeScript SDK | Scoped context, memory, environment, and artifact tools |
| Codex | Local app-server protocol adapter | Native sessions, streamed events, model/reasoning selection, approvals, and interruption |
| Claude | `@anthropic-ai/claude-agent-sdk` | Claude harness sessions, tools, hooks, and approval callbacks |
| Copilot | `@github/copilot-sdk` | Copilot CLI-backed sessions, tools, permissions, and events |
| Process execution | Execa with Kode platform adapters | Argument-safe subprocesses, streaming, cancellation, executable/shim resolution |
| Git integration | Installed Git CLI through structured subprocess calls | Worktrees, revision/status discovery, diffs, and lifecycle reconciliation |
| Filesystem tracking | Chokidar plus Git polling and hash reconciliation | Incremental refresh and recovery from missed events |
| Dependency handling | Kode environment adapters; npm and NuGet first | Reuse existing installs, native caches, compatible snapshots, and setup receipts |
| Browser proof | Playwright Test | Browser/API scenarios and inspectable traces/artifacts |
| Other repo proofs | Declared repo commands with report adapters | Preserve existing framework choices; ingest JUnit-style/XML or explicit JSON results |
| Observability | OpenTelemetry JS API/SDK/exporters, OTLP, W3C Trace Context | Vendor-neutral traces, metrics, and correlated logs |
| Structured application logs | Pino with a redacting OTel log bridge | Bounded JSON logs; diagnostics never corrupt TUI rendering or JSON command output |
| Core/integration testing | Vitest | State machines, adapter contracts, recovery, index freshness, and environment behavior |
| Terminal testing | `ink-testing-library` plus `node-pty` test harness | Component interactions plus real terminal resize/input/approval/cancellation behavior |
| Quality tooling | ESLint + typescript-eslint + Prettier | Typed linting and consistent formatting |
| CI/release | GitHub Actions, npm package, platform archives | Cross-platform checks and installable CLI releases |

Node 24 is a supported LTS line at decision time. Node 24.22.1 has been installed and activated through nvm at the user's request; npm 11.19.1 was verified. Pin this runtime in scaffolding and validate dependency compatibility rather than use an unspecified latest runtime. [Node release schedule](https://nodejs.org/en/about/previous-releases)

## Rich CLI implementation

React/Ink is the selected interface framework, not a deferred experiment. Build a full interactive terminal workspace from the first vertical slice: task/agent lanes, expandable tools/commands, approval inbox, context and shared-memory inspectors, diffs, proof matrix, search/filter, and lifecycle controls. Commander handles command dispatch; Ink renders the interactive mode. [Ink](https://github.com/vadimdemedes/ink), [Commander](https://github.com/tj/commander.js)

Implement Kode's own focused terminal components and bounded/virtualized histories rather than assemble unrelated prompt libraries for every interaction. Support keyboard navigation, narrow-terminal layouts, resize recovery, text alongside color, and a linear accessible mode. Stream structured events into a client-side view model, coalescing high-volume updates; do not render directly from every subprocess byte.

`--json` and `--no-tui` use the same core. JSON output is framed/documented and remains free of SDK banners, progress escapes, and diagnostic text. A separate browser dashboard, Electron shell, or embedded browser is outside this stack. Playwright opens the application under test, not a Kode GUI.

## Runtime and persistence boundaries

Use one workspace runner process that owns provider sessions, task scheduling, live approval waiters, environment preparation, and generation publication. The CLI/TUI attaches as a client. An initial foreground launch can start this runner automatically; it is local application infrastructure, not an installed OS service.

Use versioned JSON-RPC messages over user-restricted local IPC: Unix-domain sockets on macOS/Linux and named pipes on Windows. Authenticate attached clients with a per-workspace token and platform access controls; bound message sizes and validate all messages with Zod. Do not require an HTTP server or open TCP control port. The runner lease prevents competing owners; reconnect replays durable event sequences and reconciles native live state.

SQLite has a single application write owner. Run synchronous `better-sqlite3` operations in a dedicated worker with bounded transactions/queries so graph traversal or migrations cannot freeze approval handling or terminal rendering. Use explicit SQL migrations, foreign keys, indexes, and WAL where supported. Extracted graph data is logically distinct from durable decisions/proof history and can be rebuilt without deleting workflow records. [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

Do not start with a general ORM, Redis queue, hosted workflow engine, or agent orchestration framework. Workflow transitions, leases, idempotency, retry bounds, approval delivery, and recovery remain visible Kode code with explicit tests. Provider-specific behavior lives behind capability-aware adapters. No raw model API is required to replace the native coding harness loops.

## Contracts, indexing, and memory

Use one Zod schema source for runtime validation and generated JSON Schemas. Parse YAML as data with bounded aliases/document size and actionable path-level errors. Version every persisted message/manifest and provide migrations where needed. Retain native provider payloads separately from normalized contracts. [Zod](https://zod.dev/)

Follow [ADR-001](index-and-kg-decision.md) and the [refresh policy](index-refresh-policy.md) for XERJ, SQLite facts, semantic coverage, local edits, and worktree generations. Use Tree-sitter's WASM distribution and versioned language grammar assets to reduce host compiler dependence; validate actual grammar/query behavior on all target architectures. SCIP indexers remain external language tooling, invoked under repo permissions and recorded tool versions. [Tree-sitter bindings](https://tree-sitter.github.io/tree-sitter/)

Shared memory and environment reuse follow [ADR-002](agent-memory-and-environments.md); approvals follow [ADR-003](approval-broker.md). SQLite stores authoritative shared records and receipts. XERJ indexes permitted summaries as a derived view, and agent tools read fresh critical handoffs from the authoritative service. Content hashing uses Node's built-in cryptography rather than another hashing dependency.

## Execution and dependency handling

Execa is the subprocess API, not the whole process-isolation solution. Kode's platform layer handles process-tree cancellation, argument arrays, Windows shims, application-data paths, terminal cleanup, environment filtering, and ownership. Use Git's machine-readable output with NUL-delimited paths. Do not infer complete filesystem changes from the command string or provider tool name. [Execa](https://github.com/sindresorhus/execa), [Chokidar](https://github.com/paulmillr/chokidar)

npm is the package manager for developing Kode; it does not replace a managed repo's declared manager. Declare Kode's packages in the root `package.json` workspaces array and commit a root `package-lock.json`. Use npm workspace scripts and `npm ci` for clean CI installs; normal task execution still follows environment reuse rather than unconditional clean installation. Reuse each managed repo's existing stores/configuration and health-checked environments. A prepared environment belongs to a worktree/fingerprint, not an agent conversation. No global package-cache clearing or repeated unconditional setup.

Reuse existing provider credential mechanisms or explicitly supplied environment credentials. Persist only credential references; do not create a new plaintext credential store or add an unnecessary native keychain dependency. New credentials requiring OS storage can later use a separately reviewed credential adapter.

## Proof and observability

Kode tests use Vitest. Browser proof uses Playwright Test; framework-specific project tests remain repo commands. JUnit-style reports are an interoperability format, not a formal claim of a single universal schema: adapters validate supported dialects and stable scenario IDs. Kode stores its own versioned evidence manifest, exact input/environment hashes, original reports, and artifact checksums. [Vitest](https://vitest.dev/guide/), [Playwright traces](https://playwright.dev/docs/trace-viewer)

Terminal interaction tests use Ink component tests and PTY-driven acceptance scenarios. A native PTY binding is a development/test dependency, not a reason to place all production provider sessions in PTYs. Native terminal/desktop automation for apps under development remains a platform-specific proof adapter.

Use compatible OpenTelemetry package versions and standard OTLP exporters, with W3C propagation where supported. Bridge Pino records with trace/span correlation and redact before persistence/export. The durable event/evidence database is authoritative; the TUI uses local events rather than depending on a telemetry backend. SDK/signal and GenAI convention stability must be checked when versions are pinned. [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/)

## Repository layout

```text
apps/
  cli/                  # Commander entry point and Ink interface
  runner/               # Workspace lifecycle, IPC and task orchestration
packages/
  contracts/            # Zod schemas, event and RPC types
  core/                 # Specs, task DAG, approvals, memory, environment logic
  storage/              # SQLite worker, migrations, artifacts
  context/              # Extraction, SCIP, XERJ, graph and refresh
  providers/            # Codex, Claude and Copilot adapters
  execution/            # Git, subprocesses and platform behavior
  proof/                # Runners, reports and evidence validation
  observability/        # OTel setup, logs, correlation and redaction
```

Keep internal modules simple; this layout does not require independently publishing every package. Use npm workspaces with matching internal package versions and TypeScript project references; do not use pnpm's `workspace:` dependency protocol. Avoid adding a monorepo task runner until ordinary workspace scripts are insufficient.

## Distribution and release gates

Publish a Node-based CLI npm package with a `kode` bin entry. Users need a supported Node runtime and their chosen provider tooling/authentication. Also produce platform archives containing the tested runtime, emitted JS, required native assets, and launcher so users can run without installing Node separately. These are directories/archives, not a promise that arbitrary native SDKs can be bundled into one executable.

Pin XERJ, SQLite binding, parsers/grammars, and SDK versions; verify assets and licenses. Use tested prebuilt assets where available. An unsupported native build should fail with diagnostics rather than silently demand a compiler during ordinary installation. Provider tool binaries remain explicit managed/discovered dependencies; bundle them only if their licensing/authentication/distribution terms and update behavior permit.

Target Windows/macOS/Linux on x64 and arm64. Mark an OS/architecture supported only after native assets and clean-install workflows pass; record gaps explicitly. CI covers supported targets, with terminal tests and real provider probes staged according to available runner credentials. Packaging must preserve dynamic SDK loading, worker paths, WASM grammars, SQL migrations, and native bindings.

Lock dependency resolution in the root `package-lock.json` and pin Node 24.22.1/npm 11.19.1 toolchains during scaffolding; validate package compatibility rather than invent untested version combinations in this document. Require typecheck/lint, meaningful unit/contract tests, clean install/startup, provider approval round trips, dirty-worktree indexing, dependency reuse, and a full approved-spec-to-proof vertical slice before calling the stack integrated. No application code or installed packages are created by this ADR.
