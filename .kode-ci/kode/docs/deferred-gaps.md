# Deferred implementation and validation gaps

The user authorized continuing to P02/P03 on 7 November 2026 while retaining the
following P00/P01 gaps for a later visit. This changes the development sequence;
it does not turn missing evidence into a passed acceptance criterion.

Current scope update, 7 November 2026: the user selected **Codex only for now**.
Claude/Copilot live validation stays deferred for their later adapters; neither is
required to continue this milestone. Codex's bounded live read-only/approve/deny
checks were rerun successfully. Git is now initialized locally, with no remote.

| ID | Origin | Gap | Revisit / closure evidence |
| --- | --- | --- | --- |
| GAP-001 | P00-A03, P10 | Deferred by user: Claude authenticated probes are outside the current Codex-only milestone. | Configure authentication and run the live probe when Claude is enabled; retain real outcomes before P10 acceptance. |
| GAP-002 | P00-A03, P10 | Deferred for the Codex-only milestone: Copilot authenticated probes have not run. | Configure entitled authentication and run the live probe when Copilot is enabled; retain real outcomes before P10 acceptance. |
| GAP-003 | P00-A05, P01-A01/A02 | macOS/Linux clean install, runtime assets, IPC and real PTY checks have not run. | Connect the intended Git repository and execute `.github/workflows/ci.yml`; inspect artifacts from all three OS jobs. |
| GAP-004 | P00-A05, P13 | x64/arm64 asset pins exist, but this does not qualify every architecture. | Native installation/runtime/terminal checks for each advertised architecture during P13. |
| GAP-005 | P01 telemetry, P12 | Partially resolved: CLI → IPC → background-job W3C propagation and concurrent isolation now pass on Windows. Sustained-load/backpressure and crash qualification remain. | [Trace-context report](gap-reports/GAP-005.md); remaining P12 load/fault evidence. |
| GAP-006 | P01 approvals, P08 | Current terminal approval fixture records a simulated decision; native relay is not implemented. | P08 real request delivery, denial, disconnect and recovery scenarios. |
| GAP-007 | P02/P03, P12 | Arbitrary repo commands run as the OS user; read-only roots reject dispatch. Escaped/detached descendants and hard-crash orphan reconciliation require stronger containment. | P08/P12 enforced sandbox/process ownership and recovery tests; interrupted P03 environments stay unready and use fresh-tree recovery. |
| GAP-008 | P03-A04, P12/P13 | Core fingerprints and declared native validators exist; full native-addon and SDK/configuration matrix has not been exercised. | Native health/ABI and SDK-change scenarios across supported OS/architectures before release qualification. |

P00 and P01 remain locally verified with deferred acceptance gates. Their phase
reports describe exactly which evidence exists. Keep these gaps visible in later
phase reports and release qualification; do not silently close them.

GAP-005 is split into concrete closure items so that one passing test does not hide
unrun qualification:

| Item | Status | Evidence / remaining work |
| --- | --- | --- |
| GAP-005.1 — W3C propagation and async isolation | Fixed and Windows verified | Real CLI processes, local IPC, background-job spans, durable event IDs, OTLP log correlation, tracestate, invalid/bounded carriers, legacy negotiation; `tests/tracing.test.ts`. |
| GAP-005.2 — Sustained load and export backpressure | Open | P12-duration sustained replay, responsiveness/buffer budgets and visible drop accounting. Existing bounded SDK configuration is not a measured load result. |
| GAP-005.3 — Trace continuity across crash/recovery and later adapters | Open | Preserve durable correlation while reconciling uncertain native work; extend propagation at future P08/P10 boundaries. Do not invent spans for work whose outcome is unknown. |
