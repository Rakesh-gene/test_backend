# Deferred implementation and validation gaps

The user authorized continuing to P02/P03 on 7 November 2026 while retaining the
following P00/P01 gaps for a later visit. This changes the development sequence;
it does not turn missing evidence into a passed acceptance criterion.

Current scope update, 7 November 2026: the user selected **Codex only for now**.
Claude/Copilot live validation stays deferred for their later adapters; neither is
required to continue this milestone. Codex's bounded live read-only/approve/deny
checks were rerun successfully. Git is initialized locally without a root remote;
an isolated branch in the selected backend repository hosts native CI snapshots.

| ID | Origin | Gap | Revisit / closure evidence |
| --- | --- | --- | --- |
| GAP-001 | P00-A03, P10 | Deferred by user: Claude authenticated probes are outside the current Codex-only milestone. | Configure authentication and run the live probe when Claude is enabled; retain real outcomes before P10 acceptance. |
| GAP-002 | P00-A03, P10 | Deferred for the Codex-only milestone: Copilot authenticated probes have not run. | Configure entitled authentication and run the live probe when Copilot is enabled; retain real outcomes before P10 acceptance. |
| GAP-003 | P00-A05, P01-A01/A02 | Closed: clean npm install, runtime assets, IPC, real PTY and both selected repository fixtures pass on Windows x64, Linux x64 and macOS arm64. | [Inspected native CI evidence](gap-reports/GAP-003.md), run 42341227806. |
| GAP-004 | P00-A05, P13 | Partially qualified: Windows x64, Linux x64 and macOS arm64 passed. Other advertised OS/architecture pairs remain unqualified. | Native installation/runtime/terminal checks for Windows arm64, Linux arm64 and macOS x64 during P13. |
| GAP-005 | P01 telemetry, P12 | Resolved for implemented CLI/IPC/jobs: W3C propagation, standard queue/drop/failure diagnostics, sustained native PTY load and crash trace reconciliation. Future native-provider continuity remains a P08/P10 adapter acceptance obligation. | [Measured load and recovery report](gap-reports/GAP-005.md); broader P12 fault/performance qualification remains separate. |
| GAP-006 | P01 approvals, P08 | Implemented for Codex: durable native relay, actual PTY approve/deny/failure, stale-grant refusal and live crash recovery. | [Approval evidence and scope](gap-reports/GAP-006.md); live file/question inference and other provider/OS combinations remain later adapter qualification. |
| GAP-007 | P02/P03, P12 | Implemented Windows kernel process ownership and optional strict Linux containers with scoped mounts and crash cleanup. Native mode retains its explicitly displayed OS-user boundary. | [Containment evidence and limits](gap-reports/GAP-007.md); container service/receipt adapters and macOS Docker qualification remain separate obligations. |
| GAP-008 | P03-A04, P12/P13 | Implemented actual native-addon health/ABI and selected SDK/configuration checks; existing installations stay preserved. | [Native environment matrix](gap-reports/GAP-008.md); other architecture pairs remain GAP-004/P13, and native receipts cannot validate container dependencies. |

P00–P03 now have inspected native evidence on the three hosts above. Provider scope
remains Codex-only with live evidence on Windows; CI performs local feasibility
checks without provider credentials. The remaining deferred gates stay visible in
phase reports and release qualification.

GAP-005 is split into concrete closure items so that one passing test does not hide
unrun qualification:

| Item | Status | Evidence / remaining work |
| --- | --- | --- |
| GAP-005.1 — W3C propagation and async isolation | Fixed and verified on the three native CI hosts | Real CLI processes, local IPC, background-job spans, durable event IDs, OTLP log correlation, tracestate, invalid/bounded carriers, legacy negotiation; `tests/tracing.test.ts` and [native evidence](gap-reports/GAP-003.md). |
| GAP-005.2 — Sustained load and export backpressure | Fixed; ten-minute Windows x64 qualification passed | Five simulated agents, 10,000 initial events, 120,000 new events, 150 ms key p95, bounded queues/recent activity, collector delay/outage/recovery, visible loss and 11 exactly-once fixture decisions. Native CI includes short regressions, not ten-minute qualification on every host. |
| GAP-005.3 — Trace continuity across crash/recovery and later adapters | Fixed for current jobs; later adapters retain an explicit acceptance obligation | Trace context is durable before dispatch; a killed runner reconciles under that parent with blocked/unknown outcome and no command replay. Legacy/invalid context is unavailable. P08/P10 must exercise the same contract for actual native sessions/callbacks when implemented. |
