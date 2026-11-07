# ADR-002: Agent execution memory and reusable environments

Status: selected design requirements; implementation and package-manager adapters remain to be validated. Recorded 6 November 2026.

## Decision

Add two Kode-owned services: an execution memory service for agent collaboration and an environment manager for dependency reuse. Both persist across task attempts and process restarts. Provider sessions remain useful private conversation context, but neither service depends on a provider retaining its conversation.

## Agent memory

Use structured records in Kode's SQLite state with versioned history, plus artifact references for large content. XERJ can index permitted memory summaries as a derived retrieval view; direct SQLite reads remain authoritative for fresh decisions. Do not depend on delayed search ingestion to deliver critical handoffs.

Scopes:

- Attempt-private scratch: working notes visible to the assignment and coordinator according to policy.
- Task memory: implementation state, experiments, failures, commands attempted, and next steps shared with replacement agents on that task.
- Run/feature shared memory: decisions, contracts, findings, blockers, dependency handoffs, and environment readiness shared among authorized collaborating agents.
- Workspace/repo memory: durable conventions and reusable verified findings promoted from runs with explicit provenance and validation; speculative notes are never automatically promoted as facts.

Each record contains ID, scope, kind, author agent/task/provider session, applicable roots and snapshot generations, requirement/task IDs, content or artifact references, supporting citations, status, timestamps, version, and optional supersedes/expiry fields. Record kinds include finding, decision, contract, hypothesis, failed-attempt, blocker, handoff, and environment-reference. Distinguish proposed, accepted, stale, and rejected records. Acceptance does not imply behavioral proof.

Expose `memory.read`, `memory.search`, `memory.publish`, `memory.update`, and `memory.subscribe` through the Kode agent interface. Use SQLite transactions, idempotency keys, and expected-version writes to detect concurrent updates. Decisions are revised with history rather than silently overwritten. Contradictory findings remain visible and trigger coordinator resolution; timestamps or a majority of agents do not establish correctness.

At assignment start, inject a bounded memory pack containing approved decisions/contracts, relevant findings, known failures, and the latest task handoff. On important updates, notify subscribed agents with IDs and a short change summary; fetch full details only when relevant. Avoid broadcasting all conversation text. Native subagents receive the same scoped interface where supported, otherwise their parent publishes structured handoffs.

An implementer can publish an API-contract decision that the frontend worker consumes, while a verifier records a failing integration scenario for the implementer. A dependency handoff includes commit/content-generation and artifact references; publishing a note does not itself copy code or overwrite another agent's files. Task dependencies become ready only when their required artifacts and snapshots are available, not merely because a message says done.

Before compaction, reassignment, provider switching, task completion, pause, or shutdown, checkpoint task state and artifact IDs. Persist important findings as they happen so abrupt process death loses at most uncheckpointed scratch. Resume reconstructs an assignment from the approved spec, durable memory, task graph, environment receipt, and current source snapshot. Do not rely on hidden model reasoning or raw conversation dumps as memory.

Bind code-related records to source hashes/generations and dependency fingerprints. Refresh events mark affected findings stale; keep historical notes readable with a warning but exclude stale claims from the default authoritative memory pack. Spec decisions are bound to the approved spec version and are changed through the approval workflow. Agent-produced hypotheses cannot override repository instructions, approved requirements, tool permissions, or executed proof results.

Enforce scope on reads, search, subscriptions, and writes. Sharing within a run does not grant access to every registered root. Store credentials in existing secret mechanisms, not memory. Redact sensitive payloads and apply retention/export policies. Workspace memory must not expose private data from an unrelated run to an agent without the corresponding root access.

The TUI shows shared decisions, recent findings, blockers, subscriptions, stale/conflicting records, and task handoffs. OpenTelemetry spans cover memory reads/writes/delivery; log record IDs and versions rather than raw memory contents by default. Durable memory events remain available if telemetry export is down.

## Environment reuse contract

Environment preparation is a dependency of build/test/implementation, not an unconditional install step on every task or agent launch. Discover existing tools, package-manager configuration, dependency directories, and caches before preparing anything. Reuse a compatible prepared worktree across sequential assignments when its source baseline and ownership permit; do not create a new environment merely because the agent/model/session changes.

Preparation sequence:

1. Detect the repository's declared manager/toolchain and permitted existing installations/caches.
2. Compute a compatibility fingerprint and inspect any existing environment receipt and health checks.
3. If the target worktree already has a compatible healthy environment, reuse it and skip installation.
4. If another checkout has a compatible installation, use a manager-supported reusable store or a validated relocatable snapshot materialized into the isolated worktree. Reuse is preferred; writable dependency sharing between concurrent worktrees is not the default.
5. If full environment reuse is unsafe, restore into the worktree using existing package-manager download/package caches. Network fetches occur only for missing required content under run permissions.
6. Publish a prepared receipt after command success and health validation. Dependent assignments wait for that receipt; they do not launch duplicate setup commands.

Fingerprint inputs: relevant manifest/lockfile contents, package-manager identity/version, runtime/SDK version and native ABI, OS/architecture, install flags and dependency groups, manager config/registry scope, workspace layout, local/path/workspace dependencies, patches/overrides, and install-script inputs. Use secret-free identifiers for credential scopes. Missing lockfiles or unknown installation provenance lower reuse confidence; they do not justify pretending a matching directory name establishes compatibility.

An existing user installation may contain local package patches or extra dependencies. Preserve it; assess actual compatibility using manager metadata and nonmutating checks, and capture relevant observed state when adopting it. Do not turn an unverified installation into a trusted reusable snapshot. If a package manager cannot validate safe reuse, fall back to cache-backed preparation in a Kode-owned environment and show the reason.

Receipts include fingerprint, manager/toolchain, target path/worktree, reuse source, checks performed, setup command/result, timestamps, limitations, and dependency-state identity for proof provenance. Source, environment, and generated build state are tracked separately. Revalidate after manifest/lockfile/SDK/config changes, relevant lifecycle-script inputs changing, or detected dependency corruption. Commit/pull alone is not a reason to reinstall when all compatibility inputs remain unchanged.

## Package-manager policies

| Ecosystem | Reuse policy | Isolation requirements |
| --- | --- | --- |
| npm | Reuse healthy compatible target `node_modules`; for another worktree, use a validated relocatable snapshot when available, otherwise restore using the existing npm cache | No unconditional `npm ci` on a reused installation; do not link writable trees across agents by default |
| pnpm | Reuse the configured content-addressed store and compatible target installation through pnpm's supported behavior | Preserve/validate workspace symlink topology and generated artifacts; do not invent a generic directory-copy strategy |
| Yarn | Respect the selected Yarn version, linker, cache, and project configuration | PnP state, SDK generation, native builds, and path-specific artifacts need adapter-specific handling |
| NuGet/.NET PackageReference | Reuse existing configured global packages and HTTP cache; restore only when needed for this worktree/project | Project assets and `obj`/`bin` remain worktree-specific; sharing package downloads does not make restore/build outputs portable |
| NuGet packages.config | Discover configured repository package paths and validate reuse per project | Do not assume PackageReference's global-package behavior applies |
| Other managers | Extend through explicit discovery/fingerprint/prepare/validate/cleanup adapters | Until supported, use declared repo setup commands with persistent cache configuration and explicit reuse limitations |

`npm ci` removes existing `node_modules` before installing, so blindly calling it would violate the reuse goal. It remains a valid declared clean-install command when preparation is actually required in a Kode-owned target. npm's download cache accelerates installs but is not itself an installed dependency tree. [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [npm cache](https://docs.npmjs.com/cli/v11/commands/npm-cache/)

pnpm's documented layout uses a content-addressed store with hard links and symlinks; preserve package-manager semantics. NuGet's global package folder avoids downloading versions already present, while the worktree may still need restore-generated project metadata. [pnpm layout](https://pnpm.io/symlinked-node-modules-structure), [NuGet cache behavior](https://learn.microsoft.com/en-us/nuget/consume-packages/managing-the-global-packages-and-cache-folders)

Native modules, absolute paths, executable launchers, editable/local packages, and postinstall-generated files can make a copied tree invalid even with the same lockfile. Validate relocation explicitly; do not promise zero materialization cost for every new worktree. Prefer reflink/copy-on-write where actually supported or a verified copy; generic hard links can leak mutations. Symlinks/junctions to a user's writable `node_modules` are opt-in only with enforceable access and tool-compatibility constraints. Never let an install in one worktree mutate another's dependency tree.

Retain package-manager caches and Kode-owned prepared environments across assignments/runs subject to quota and idle leases. Package-manager-native locks protect shared native caches; Kode locks its own snapshot creation/preparation and serializes writers to each target environment. Handle crash recovery before declaring a partial installation reusable. Garbage collection removes only unleased Kode-owned data; never clear the user's caches or dependency folders automatically.

Proof runs use the fingerprinted dependency state and a reproducible restore path. Reusing local packages does not waive lockfile checks or required integration/UI proofs. Build outputs/test data remain isolated and may have their own explicit cache keys; `obj`, `bin`, and framework caches cannot be treated as universally reusable packages. Cache hits/misses/reuse source and invalidation reasons appear in the TUI and OTel metadata.

## Repository and agent configuration

Add an optional dependencies block to `kode.yaml`; common repos need only `manager` and `reuse`. Auto-detection can fill unset defaults, and `kode repo inspect` explains the resolved policy. See [Node example](examples/kode.yaml) and [.NET example](examples/kode-dotnet.yaml).

```yaml
dependencies:
  manager: npm
  reuse: auto
  prepare: install
```

`prepare` references a named repo command and runs only when environment validation establishes a need. `reuse: auto` means compatible existing environment first, validated snapshots second, manager-cache-backed preparation otherwise. Commands invoked directly by a user remain literal; `kode command run api install` executes the requested install command rather than silently skipping it.

Agent definitions can declare a memory policy (`run-shared` by default for collaboration), publication kinds, and required environment capabilities. Kode enforces actual memory/root permissions and environment ownership. Agents request preparation via the environment service instead of each executing their own install loop. Raw shell installs are observed, serialized or reconciled where possible, and invalidate receipts when they mutate dependency state.

Proposed commands: `kode memory list RUN-001`, `kode memory show MEM-001`, `kode env inspect api`, and `kode env prepare api`. These are proposed Kode interfaces, not current executables.

## Delivery and validation

Implement SQLite-backed shared task/run memory, checkpoint/handoff delivery, and the environment manager in the first vertical slice. Start dependency adapters with npm and NuGet PackageReference; follow with pnpm/Yarn and additional ecosystems. The initial release must demonstrate reuse of an existing compatible install and manager cache reuse in fresh isolated worktrees.

Required checks: concurrent memory updates/conflicts; scoped memory access across roots; stale findings after edits/pull; replacement agent recovering an interrupted task; an API-to-UI contract handoff; existing matching versus mismatched installs; unchanged lockfile with native ABI/config changes; local/workspace packages and patched dependencies; two agents requiring the same preparation; failed install/restart; offline execution with complete versus incomplete caches; no writes escaping through links; lockfile changes after pull; independent .NET project assets with shared package cache; and cleanup preserving user-owned installations. Validate representative cases on Windows, macOS, and Linux.
