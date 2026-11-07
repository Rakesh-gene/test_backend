# Two-repository CI acceptance

The user selected these public repositories on 7 November 2026:

- `https://github.com/Rakesh-gene/test_backend` — .NET 10/PostgreSQL API and repository/API tests.
- `https://github.com/Rakesh-gene/test_frontend` — React/Vite application.

The backend hosts a dedicated `kode/acceptance-*` CI branch. A versioned source-only
Kode snapshot lives under `.kode-ci/kode/` on that branch; application code and main
remain unchanged. The frontend is a separate checkout, not a copy embedded into Kode.
This arrangement lets the user-selected repositories run Kode's acceptance without
requiring a third GitHub repository. The branch workflow is generated from
`two-repo-workflow.yml` and pins both fixture commit IDs. A future standalone Kode
remote can replace the temporary snapshot host.

Each Windows/macOS/Linux job installs the pinned toolchains, verifies XERJ's platform
archive hash, and runs the full Kode suite, real PTY checks, strict offline feasibility
probe, and `scripts/repository-acceptance.mjs`. The latter creates isolated worktrees,
adds repo command manifests there, uses npm/NuGet caches, proves a repeat preparation
does not install again, builds/tests both projects and starts owned backend/frontend
processes. Native PostgreSQL is provisioned in each CI runner using the pinned
[setup action](https://github.com/ikalnytskyi/action-setup-postgres), without a container requirement.
HTTP assertions traverse the actual Vite proxy into the PostgreSQL-backed API:
registration, authentication/session, duplicate/invalid input, update, get and list. This is HTTP integration
and entrypoint serving; browser interaction/proof closure remains P09.

Before/after source content and installation metadata hashes must agree. Original
checkouts and their installations are preserved. Reports include exact repo revisions,
input digests, receipts, command exits, teardown and assertions. Retained worktrees
are local evidence; only an explicit report allowlist is uploaded, excluding dependency
trees, SQLite databases, credentials and whole workspace directories.

For a local run after building Kode:

```sh
node scripts/repository-acceptance.mjs --backend /repos/test_backend --frontend /repos/test_frontend
```

`KODE_BACKEND_ROOT` and `KODE_FRONTEND_ROOT` can supply those paths in CI.
Current backend revisions also require `ASDS_POSTGRES_CONNECTION_STRING` pointing
to a disposable fixture database. Older SQLite revisions remain supported for
replaying historical results. The original local clones lagged remote main;
the workflow pins the inspected newer remote commits rather than silently testing
those older clones. NuGet's `dependencies.projects` selects the solution's actual
projects, excluding a retained compatibility project outside the solution.
The frontend lint command explicitly selects its existing ESLint legacy config.
`KODE_VERIFY_TIMEOUT_MS=240000` gives each full verification subprocess an explicit
CI deadline; the developer default remains 90000 ms. The observed configured deadline
is recorded per check. No platform gate closes before its native job passes and its
reports are inspected.
