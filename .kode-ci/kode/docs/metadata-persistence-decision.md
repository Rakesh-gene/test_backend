# ADR-005: P02/P03 local metadata persistence

Status: implemented, 7 November 2026.

P02/P03 store workspace registration, baseline manifests, task-tree descriptors,
environment receipts and asynchronous job results as versioned private JSON files
under `.kode`. Writes use a fresh temporary file, file sync and atomic rename;
per-resource exclusive leases serialize mutations. Content blobs are SHA-256 keyed
and verified before materialization. Incomplete files never constitute ready state.

SQLite remains the runner-owned durable event/audit store through its existing
worker. Workspace command/environment/service events use that store and the existing
telemetry pipeline. This is a scoped refinement of ADR-004, whose original table
assigned environment receipts and workflow state to SQLite. These small local
resource descriptors currently have no cross-resource transaction/query requirement;
using inspectable atomic descriptors avoids adding an unproven migration during the
filesystem/environment phase. It does not replace SQLite for the graph, approval,
memory or scheduler services in subsequent phases.

Tradeoffs: descriptor changes and event appends are not one transaction. Recovery
uses the conservative descriptor state; a missing completion event never makes an
interrupted job ready. P07/P12 must revisit a transactional SQLite catalog when
cross-resource scheduling/recovery is introduced. Power-loss/filesystem durability,
automatic orphan adoption and crash-safe multi-resource transactions remain P12
qualification work. Do not infer process completion from a JSON status after a
runner restart: unfinished jobs are explicitly reported blocked.
