# Index and knowledge graph freshness policy

Status: required behavior for ADR-001. Proposed scheduling defaults are configurable and must be profiled. Recorded 6 November 2026.

## Source of truth

Kode indexes the actual permitted files in each working tree, including local changes made by users, agents, editors, build tools, or external Git clients. HEAD is a baseline and provenance marker, not the complete source of truth.

Include tracked files with staged or unstaged modifications, tracked additions/deletions, and nonignored untracked files. Preserve the distinction between HEAD, staging-area status, and disk contents. For partially staged files, normal context reads the disk version; staged-only inspection is an explicit separate mode. `git add` changes staging metadata without necessarily changing indexed content.

Do not index ignored secrets, excluded paths, or arbitrary Git objects merely because they exist locally. Changes to ignore/configuration rules trigger discovery reconciliation and removal of newly excluded content from current search/graph views. Unsaved editor buffers are not visible to filesystem indexing; a future editor integration must identify buffer snapshots explicitly rather than call them disk contents.

Use machine-readable, NUL-delimited Git status/path outputs for discovery and preserve filenames exactly. Hash actual bytes for identity; timestamps and Git status alone are not a content integrity check. Support unborn branches, detached HEAD, linked worktrees, submodules, and non-Git roots. Resolve actual Git/worktree metadata paths through Git rather than assuming `.git` is a directory. [Git status](https://git-scm.com/docs/git-status), [Git worktree](https://git-scm.com/docs/git-worktree)

## Existing edits when a run starts

At root registration, startup, resume, and task dispatch, reconcile disk state before constructing context. If a repo is already dirty, record its permitted tracked changes, untracked files, and deletions in an immutable run input snapshot with hashes and provenance.

When creating an implementation worktree, materialize that captured baseline into the isolated worktree, including tracked modifications, deletions, and permitted untracked additions. A plain worktree created from HEAD would omit these changes and is insufficient. Do not require the user to commit or stash, alter the user's staging area, or silently discard edits. Untracked path collisions, unresolved conflicts, or changes during capture produce a clear conflict/retry state rather than a guessed baseline.

Compare later agent changes against the captured dirty baseline so closure distinguishes pre-existing edits from work performed by Kode. Handle staged/unstaged metadata in the source repo separately; execution worktrees need the captured file contents, not mutation of the source staging area. If the approved spec relied on local changes, its execution worktrees must include the matching snapshot or trigger a context/scope review.

Each agent sees its own worktree plus the explicitly assigned input/dependency snapshots. Changes from other agents become visible through a controlled dependency handoff or integration, with corresponding reindexing. Main-checkout edits do not automatically overwrite active agent worktrees. Unexpected writes inside an agent-owned worktree mark affected tasks for reconciliation; indexing freshness does not grant edit ownership.

## Detection and scheduling

Use four complementary signals:

1. Filesystem events enqueue changed/deleted/discovered paths immediately, independent of the writer.
2. Provider edit-tool callbacks and completion of mutating shell/build/Git commands enqueue likely changes and trigger status reconciliation. Inspect the filesystem rather than trust a reported changed-file list.
3. Poll working-tree Git state and metadata for external operations, and periodically reconcile file discovery/content hashes to catch dropped watcher events. Watcher overflow or uncertain rename detection marks the root dirty for a full reconciliation.
4. Enforce synchronous freshness barriers at task dispatch, dependency handoff, implementation/integration completion, proof start, and closure. A manual refresh uses the same mechanism.

Initial scheduling defaults: debounce ordinary edit bursts by 500 ms, with a maximum 2-second queue delay before attempting syntax/search refresh; poll Git state every 2 seconds while a run is active and every 30 seconds while idle; perform a background full reconciliation every 5 minutes while active and immediately after resume/overflow. These are scheduling targets, not promises that a large repo finishes indexing in two seconds. An idle workspace can reconcile on next use instead of running continuously.

Tree-sitter/search refresh takes priority over expensive SCIP enrichment. Schedule SCIP after an edit burst settles (initial idle target: 5 seconds), coalesce pending requests, and enforce repo command time/resource limits. If the indexer only supports project-wide runs, rerun the affected project rather than promise file-level semantic refresh. Retire stale semantic facts immediately; syntax/search can become current while semantics remain rebuilding or unavailable.

Serialize publication per worktree; coalesce duplicate notifications and cancel or discard superseded builds. Content hashes allow unchanged parses/chunks to be reused. Observe indexing backlog and throttle background work during expensive builds without bypassing required freshness barriers.

## Refresh triggers

| Event | Required action |
| --- | --- |
| Register root / open / resume | Discover current HEAD/worktree/status, reconcile all permitted files, and load or publish the matching generation |
| User or agent saves/adds/deletes/renames a file | Refresh affected chunks and syntax facts; remove obsolete nodes/edges; invalidate semantic facts and cross-repo contracts affected by those files |
| Agent shell/build/generator command finishes | Reconcile resulting disk changes, including newly generated files when allowed by indexing policy; excluded build output stays excluded |
| Stage / unstage | Update staging provenance; reuse search/graph content if bytes are unchanged |
| Commit/check-in or amend | Reconcile after command completion, update HEAD/branch/staging provenance, include all remaining local changes, and reuse extraction/search data for unchanged content |
| Pull, including fast-forward, merge, or rebase | Mark the affected checkout as synchronizing, reconcile resulting HEAD plus remaining local files after completion/failure, refresh changed content, and rebuild affected semantic/project and contract facts |
| Merge, rebase, cherry-pick, revert, or conflict resolution | Reconcile each exposed stable operation boundary; mark unresolved/conflicted paths explicitly; finish with a current generation and refreshed semantic facts where possible |
| Switch/checkout, reset, restore, stash apply/pop/drop, patch application | Reconcile actual HEAD/index/disk; publish the resulting snapshot, reusing content caches where safe; operations with no content impact update metadata only |
| Fetch or push | Update remote-ref metadata when observed; no code reparse when local HEAD and working-tree content are unchanged; reconcile any local mutations caused by associated tooling |
| Worktree add/remove/move | Register/index a new permitted worktree or retire its active view; retain generations/evidence referenced by historical runs |
| Dependency lockfile, manifest, compiler config, schema, or indexing rules change | Invalidate relevant project-level semantic data, rebuild contracts and affected cross-repo edges, and reassess dependent tasks/proofs |
| Submodule revision/contents change | Reconcile the separately registered submodule root or report excluded coverage; parent refresh alone cannot establish submodule graph freshness |
| Backend crash, watcher overflow, or interrupted publication | Mark freshness unknown, reconcile and recover a coherent generation before claiming current context |

Git hooks can accelerate notification using post-commit, post-checkout, post-merge, and post-rewrite where applicable. Hooks are optional and cannot be the only detector: there is no universal post-pull hook, and different operations take different hook paths. Do not replace existing hooks or change `core.hooksPath` silently. Kode-owned command completion and disk/metadata reconciliation remain authoritative. [Git hooks](https://git-scm.com/docs/githooks)

Kode does not automatically pull, reset, switch, stash, or update active run branches to keep indexes fresh. Refresh observes state; changing a run's source baseline is a separate workflow decision.

## Query consistency and agent notification

Expose per-root states: `current`, `dirty`, `refreshing`, `conflicted`, `unavailable`, and `unknown`. Report syntax/search freshness separately from semantic coverage. Attach observed timestamps, generation IDs, HEAD/content fingerprints, queued changes, and outstanding enrichment to query metadata and the TUI.

Normal planning/implementation context queries require a current syntax/search generation for their requested snapshot. Drain known dirty events and reconcile the relevant root scope before issuing a fresh context pack; if freshness cannot be established within the bound, return a pending/error result or explicitly scoped direct-file inspection. Historical browsing can request a pinned generation, visibly labeled historical. No caller silently receives an old generation as current.

A query pins a coherent published generation. Newer edits may arrive during or after it; results remain valid for that snapshot, not guaranteed for future disk state. Before applying edits, revalidate cited source hashes and refresh/replan on mismatch. For workspace-wide impact or cross-repo queries, verify every participating root's pinned generation and invalidate cross-links whose dependencies changed.

If a change occurs during capture/extraction, use captured bytes plus manifest verification before publication. Retry the changed scope; never label a mixed-time scan current. For Kode-controlled Git operations, hold context publication for that checkout while the operation runs. External operation detection and Git lock/sequencer state are useful signals, but final content reconciliation determines readiness. Conflicted source can be inspected as partial context; it cannot pass clean integration/proof readiness.

Emit `workspace.changed`, `context.invalidated`, `index.refresh.started`, `index.generation.published`, and `semantic.refresh.completed` events with affected roots/paths/generations. Notify an active agent before its next dependent action when its context pack is invalidated; use provider steering when supported, otherwise pause/restart the relevant attempt at a controlled boundary. Do not inject the whole repo after every keystroke. Refresh the minimal pack and reassess scope if external changes affect approved assumptions.

## Proof and closure barriers

Before proof execution, reconcile all participating repos and pin the integrated file/manifest/fixture hashes. Establish required syntax/search and contract readiness; missing optional SCIP coverage can be declared, but a proof plan requiring precise graph analysis must wait or use an approved alternative. Freeze Kode writers or run proofs in immutable execution snapshots; record externally detected source changes as invalidation.

Validate input/output hashes after proof and again at closure. Test artifacts are excluded from source identity unless declared proof inputs. If code, tests, fixtures, commands, or relevant dependencies changed, invalidate and rerun affected proofs; when dependency impact is uncertain, rerun the whole required proof set. Index refresh never changes a failed proof to passed.

A commit with byte-identical inputs updates provenance without inherently forcing a rerun: preserve the original execution evidence and record explicit content equivalence for the new revision, including all proof inputs and environment compatibility. Do not relabel old evidence as a newly executed test. A pull with changed code invalidates affected proof coverage even when all current test files are unchanged.

## CLI and acceptance checks

Proposed commands: `kode index status --verbose`, `kode index refresh --repo api --wait`, `kode index refresh --repo api --semantic --wait`, and `kode index rebuild --repo api`. Refresh reuses valid content; rebuild regenerates derived index/graph data without deleting source, approvals, or evidence. A rebuild command does not itself rerun behavioral proofs.

Required validation cases: startup with staged and unstaged edits in the same file; untracked addition/deletion/rename; dirty-baseline worktree materialization; external editor changes; provider shell writes that bypass edit hooks; commit with identical bytes; pull via fast-forward/merge/rebase; failed/conflicted pull; branch switch; stash/reset/restore; linked worktrees and submodules; missed watcher events; changes during extraction/query/proof; dependency changes affecting another root; and closure with stale evidence. Run representative cases on Windows, macOS, and Linux.
