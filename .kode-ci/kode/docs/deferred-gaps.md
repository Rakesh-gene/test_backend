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
| GAP-005 | P01 telemetry, P12 | Partially resolved: CLI → IPC → background-job W3C propagation and concurrent isolation pass on all three tested native hosts. Sustained-load/backpressure and crash qualification remain. | [Trace-context report](gap-reports/GAP-005.md); remaining P12 load/fault evidence. |
| GAP-006 | P01 approvals, P08 | Current terminal approval fixture records a simulated decision; native relay is not implemented. | P08 real request delivery, denial, disconnect and recovery scenarios. |
| GAP-007 | P02/P03, P12 | Arbitrary repo commands run as the OS user; read-only roots reject dispatch. Escaped/detached descendants and hard-crash orphan reconciliation require stronger containment. | P08/P12 enforced sandbox/process ownership and recovery tests; interrupted P03 environments stay unready and use fresh-tree recovery. |
| GAP-008 | P03-A04, P12/P13 | Core fingerprints and declared native validators exist; full native-addon and SDK/configuration matrix has not been exercised. | Native health/ABI and SDK-change scenarios across supported OS/architectures before release qualification. |

P00–P03 now have inspected native evidence on the three hosts above. Provider scope
remains Codex-only with live evidence on Windows; CI performs local feasibility
checks without provider credentials. The remaining deferred gates stay visible in
phase reports and release qualification.

GAP-005 is split into concrete closure items so that one passing test does not hide
unrun qualification:

| Item | Status | Evidence / remaining work |
| --- | --- | --- |
| GAP-005.1 — W3C propagation and async isolation | Fixed and verified on the three native CI hosts | Real CLI processes, local IPC, background-job spans, durable event IDs, OTLP log correlation, tracestate, invalid/bounded carriers, legacy negotiation; `tests/tracing.test.ts` and [native evidence](gap-reports/GAP-003.md). |
| GAP-005.2 — Sustained load and export backpressure | Open | P12-duration sustained replay, responsiveness/buffer budgets and visible drop accounting. Existing bounded SDK configuration is not a measured load result. |
| GAP-005.3 — Trace continuity across crash/recovery and later adapters | Open | Preserve durable correlation while reconciling uncertain native work; extend propagation at future P08/P10 boundaries. Do not invent spans for work whose outcome is unknown. |
