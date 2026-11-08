# Kode

A rich terminal workspace for spec-driven and proof-driven coding across repositories.

P00–P03 have local Windows implementations and verification. Deferred acceptance gaps
are tracked in [the gap ledger](docs/deferred-gaps.md). Later-phase agent execution, real workspace indexing,
spec generation, shared execution memory, and proof runners are **not yet connected to the
interactive product**. The terminal's fixture mode is explicitly simulated.

## Develop

Use nvm to select Node **24.22.1**, with npm **11.19.1**.

```sh
npm ci
npm run build
npm run check
npm run test:terminal
npm run verify
```

The workspace uses npm workspaces, strict TypeScript, React/Ink, a local runner,
authenticated JSON-RPC over named pipes/Unix sockets, SQLite in a worker, and
OpenTelemetry traces/metrics/logs. Packages are version-pinned in the manifests and lockfile.

## Run the rich CLI

```sh
npm run kode -- --help
npm run kode -- doctor --json
npm run kode -- --root .
```

To inspect the interactive design using simulated tasks/tools/approvals:

```sh
npm run kode -- --root . runner stop
npm run kode -- --root . --fixture
```

The stop command reports an error if no runner exists; in that case continue with the
fixture command. A running non-fixture runner cannot be silently switched into fixture
mode. Use a separate scratch folder to preserve an existing workspace runner.

Keys: Tab/left/right or 1–7 select panes; `/` filters recent events; arrows select a
pending fixture approval; Enter arms that selection, then `y`/`n` records the decision;
Escape clears; `q` detaches. New approvals never select their own response. Fixture
approval decisions never execute a command or stand in for a native provider decision.

The runner stays active after detaching. Inspect or stop it with:

```sh
npm run kode -- --root . status --json
npm run kode -- --root . runner stop
```

For JSON suitable for piping without npm's script banners, invoke the built entry directly:

```sh
node apps/cli/dist/index.js doctor --json
node apps/cli/dist/index.js --root . --json
```

State, credentials for local IPC, and diagnostic logs live in the ignored `.kode/` directory
of the selected workspace. Treat this directory as private. Runtime permission approvals
are separate from specification approval. The P01 runtime has no native agent execution
methods, so broad agent sandbox enforcement is a later integration requirement.

## Feasibility probes

```sh
npm run probe -- --offline
node scripts/setup-xerj.mjs
npm run probe -- --offline --require-local
npm run probe:providers
npm run probe -- --live-codex --codex-permissions
```

Default probes do not send an inference request. `--live-codex` uses the current user's
configured Codex authentication for a bounded synthetic read-only assignment.
`--codex-permissions` runs explicitly controlled approve/deny probes for a harmless
marker-printing command; this is not the P08 terminal-to-native approval broker.
Claude/Copilot live acceptance still requires their own configured authentication.
After configuring it, run the corresponding bounded suite explicitly:

```sh
node scripts/provider-live.mjs --provider claude
node scripts/provider-live.mjs --provider copilot
```

Do not paste credentials into project files, reports, or chat.

`setup-xerj.mjs` downloads the pinned official release for the current OS/architecture,
verifies its pinned SHA-256 before extraction, and records its binary hash. It requires
system `tar` (included on supported Windows/macOS/Linux hosts); Linux assets target glibc.
Set `KODE_XERJ_ARCHIVE` to a local release archive to install without downloading.
Alternatively, set `KODE_XERJ_PATH` to a separately checksum-verified binary. On this Windows development
machine, the probe also discovers the ignored `.tools/xerj/bin/` installation. XERJ binds
loopback only for the synthetic probe, with external feedback disabled. Default disk
watermarks are respected. If the host is above 95% used, the optional
`--probe-relax-disk-watermark` starts **only that disposable fixture node** at 99%; it
does not change a production configuration. Preserve this qualification in its report.

Generated reports and terminal captures are in ignored `.artifacts/`. The offline probe
can report missing optional binaries as blocked without making an inference call;
this is not a declaration that all P00 acceptance criteria passed.
CI uses `--require-local`, which fails if XERJ or another required local feasibility
check is blocked. Provider inference remains a separate authenticated gate.

## Multiple roots and repository execution

P02/P03 add `init`, `folder add/list/remove`, `capture`, `tree create/retain/cleanup`,
`repo init/inspect`, `command run`, `env inspect/prepare`, and `job show/cancel`.
See [workspace and command usage](docs/workspace-and-commands.md) for runnable
examples, `kode.yaml`, dependency reuse, service lifecycle, and recovery boundaries.
Read-only registrations refuse arbitrary command execution. Original dirty files
and staging are preserved when creating isolated task input trees.

## Observability

The current milestone uses Codex; Claude/Copilot live acceptance is deferred.
W3C trace context now follows CLI → runner IPC → background jobs. For an instrumented
parent process, set `TRACEPARENT`/`TRACESTATE` when launching the CLI. Tool events and
logs share the active trace/span IDs; older runner peers negotiate context support.
See the [gap report](docs/gap-reports/GAP-005.md) for verified scope and remaining
load/recovery qualification.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or signal-specific endpoints) to export. Standard OTLP
exporter environment configuration applies. Without an endpoint, durable local events
still work. Export queues and request sizes are bounded; the SQLite worker keeps database
queries off the runner/terminal event loop. Credentials and configured secret strings are
redacted before event/log/export sinks.

## Acceptance status

See [P00](docs/phase-reports/P00.md), [P01](docs/phase-reports/P01.md), the
[implementation phases](docs/implementation-plan.md), and [stack](docs/tech-stack.md).
The [inspected native CI run](docs/gap-reports/GAP-003.md) passed clean installation,
compile/lint, 29 Kode tests at that revision, actual PTY, strict local probes and the selected backend/frontend
repositories on Windows x64, Linux x64 and macOS arm64. Each repository contributes
13 tests, and seven integration assertion groups traverse Vite into the PostgreSQL API.
See [reproduction and fixture configuration](docs/ci/README.md). Other architecture pairs,
native provider parity and the remaining later-phase gaps stay explicit in the ledger.

[GAP-005 validation](docs/gap-reports/GAP-005.md) adds standard OTel queue/drop/failure
diagnostics in status/the CLI and durable job trace reconciliation after a crash.
The GAP-005 revision had 31 tests. A native Windows ten-minute PTY replay processed
120,000 events with 150 ms key-to-visible p95; short native regressions complement it.

Native Codex assignments now relay approvals in the rich terminal, including durable
decisions, expiry, interruption and restart reconciliation. See [GAP-006](docs/gap-reports/GAP-006.md)
for CLI examples and the distinction between native acknowledgement and tool success.

Optional `kode execution container <local-image>` pins a Linux image for isolated
task-tree commands, with no network or native fallback. Native Windows commands use
kernel Job Objects; native filesystem access still uses OS-user permissions. See
[GAP-007](docs/gap-reports/GAP-007.md) for supported modes and current container limits.
[GAP-008](docs/gap-reports/GAP-008.md) adds real SQLite addon health, alternate Node ABI,
SDK selection and effective configuration qualification. The suite now contains 40
tests; the Windows kernel ownership test is explicitly skipped on other hosts.
