# Workspace roots, task trees and repo commands

P02/P03 add the following executable interfaces. All examples use npm for Kode.
Run them with `npm run kode -- ...` from this checkout, or with the local `kode` bin.

```sh
kode --root /work/feature init
kode --root /work/feature folder add /repos/api --name api --access write
kode --root /work/feature folder add /repos/web --name web --access write
kode --root /work/feature folder add /reference/contracts --name contracts --access read
kode --root /work/feature folder list
kode --root /work/feature repo init api --manager npm
kode --root /work/feature repo inspect api
kode --root /work/feature capture api
kode --root /work/feature tree create api
```

Use native Windows paths on Windows; paths with spaces must be quoted. Relative
folder paths resolve against `--root`. Root names are unique, canonical paths
collapse symlink/junction aliases, and Windows path aliases compare without case.
Register actual Git repository boundaries; register nested repositories separately.
`folder remove` unregisters a source without deleting it. Root access defaults to
`read`, so command execution requires explicit `--access write` registration.

Capture records HEAD (or an unborn state), branch/detached state, NUL-delimited Git
status and stage entries, and hashes/blobs of current files. Two consecutive scans
must agree; three unstable attempts block capture. A task worktree is detached at
the captured HEAD and then materialized with captured disk bytes, including staged
plus unstaged edits, untracked files and deletions. Original files, index and history
are preserved. Ordinary folders and unborn repos use isolated snapshots with
serialized materialization. Integration back into original sources belongs to P11;
creating a snapshot never applies its edits to the original folder.

Git respects tracked files plus nonignored untracked files. Ordinary folders omit
`.git`, `.kode`, `.tools`, `.artifacts`, `node_modules`, `bin`, `obj`, and `.vs`.
Captures block unmerged indexes, gitlinks/submodules, file symlinks, unsupported
entries and files above 32 MiB rather than silently inventing equivalent content.
Snapshots and blobs stay private in local `.kode`; they are not sent to a provider.

```sh
kode command run api build --tree TREE_UUID
kode command run api test --tree TREE_UUID --detach
kode job show JOB_UUID
kode job cancel JOB_UUID
kode env inspect api
kode env prepare api
kode env prepare api --tree TREE_UUID --offline
kode tree retain TREE_UUID
kode tree cleanup TREE_UUID
```

Without `--tree`, named commands run in the registered source root because the user
explicitly requested it. Environment preparation adopts healthy existing installs
there but refuses to repair/reinstall a user-owned installation. Fresh preparation
requires a Kode-owned tree. Commands are argument arrays, never shell strings. To
use a shell, explicitly declare the shell executable and its arguments. Commands
may read/write outside cwd under the user's OS identity; this is **not an OS
sandbox**. Kode therefore refuses arbitrary commands and write scope for read-only
roots. Codex assignments now require their native permission profile; optional strict container commands have a separate enforced boundary. See GAP-006/GAP-007 for qualification and limits.

Commands run as durable asynchronous jobs. The CLI waits by default, `--detach`
returns an ID, Ctrl+C requests cancellation, and other clients can inspect/cancel.
The rich CLI Overview displays registered roots; Tools displays command/service and
environment activity with status, output byte counts, fingerprints/reuse sources and
invalidation reasons. Output is bounded and redacted before returning/persisting it.
Runner logs/events use existing Pino/OpenTelemetry plumbing.

## Repository contract

`schemas/kode.schema.json` provides editor validation; runtime validation additionally
checks command references and service dependency cycles. See executable examples in
[Node](examples/kode.yaml) and [.NET](examples/kode-dotnet.yaml).

```yaml
version: 1
dependencies:
  manager: npm
  reuse: auto
  prepare: install
  # validate: health  # required for native addons; declare a health command below
  inputs: []          # extra repository-relative configuration files
  flags: []           # explicit preparation flags included in compatibility
commands:
  install:
    run: [npm, ci]
    timeout_seconds: 300
  integration:
    run: [npm, run, test:integration]
    services: [app]
    env:
      BASE_URL: http://127.0.0.1:${port:app}
  serve:
    run: [npm, run, serve]
    env:
      PORT: ${port:app}
services:
  app:
    command: serve
    port: auto
    readiness:
      http: http://127.0.0.1:${port:app}/health
      timeout_seconds: 30
```

Commands support repository-relative `cwd`, environment variables, timeouts, report
and artifact declarations. Report ingestion/proof closure is P09; declaring a report
does not claim it ran. Services support `depends_on`, `setup` and `cleanup` named
commands. Referenced services start in order, get loopback ports and await HTTP
readiness. Port placeholders are substituted literally in arguments/env/readiness.
Fixed-port collisions fail without terminating the existing listener. Automatic
port reservation is released immediately before spawn; an external bind race can
still cause readiness failure. Teardown runs cleanup and stops owned processes in
reverse order; a cleanup failure fails the job.

## Environment compatibility and recovery

Compatibility includes dependency/project/lock/configuration hashes, declared
flags/prepare/validation commands, selected tool and SDK versions, Node/native ABI,
OS/architecture, user configuration hash, and relevant environment settings. Values
are hashed into fingerprints rather than written into receipts. Declare additional
configuration through `dependencies.inputs`. External MSBuild imports and custom
tool behavior need a repo-specific validator; arbitrary undeclared inputs cannot
be inferred reliably.

npm checks lock metadata, internal installation links and `npm ls` health. Native
addons require a declared `dependencies.validate` command that loads/exercises the
relevant addon under the chosen runtime. A compatible existing installation or ready
receipt invokes zero install commands. Fresh targets use npm's cache and still
materialize their own `node_modules`; Kode does not share writable installation links
or make an unvalidated copy of native/path-sensitive dependencies.

NuGet supports PackageReference projects. Existing restore metadata must belong to
that project/worktree, be newer than known inputs, and reference present package
cache entries. Fresh trees restore their own `obj` metadata and keep independent
`bin`/`obj` outputs while reusing configured global packages. Offline preparation
restricts restore sources to the configured package cache. `packages.config` and
other managers require later adapters.

For solutions that retain inactive compatibility projects, optionally declare
`dependencies.projects: [src/Api/Api.csproj, tests/Api.Tests/Api.Tests.csproj]`.
These paths select projects whose restore metadata must be healthy; each must stay
inside the repository. Without this list, Kode checks every discovered project.
Successful preparation records the resulting manager configuration identity, so
first-time creation of user configuration does not force another identical restore.

Per-target leases serialize preparation. A `preparing` receipt is written before
installation and only validated success becomes `ready`. If its owner crashes,
the target stays unready and an in-place retry is blocked: inspect any orphan
installer and prepare a fresh isolated tree. Automatic adoption/termination of
uncertain orphan processes is deferred to P12. A runner restart similarly reports
unfinished jobs as blocked, never completed. This conservative recovery preserves
partially prepared data and prevents a false cache hit.

`tree cleanup` refuses active leases and evidence-retained trees. It removes only
the selected Kode-owned tree; baselines, source installations and manager caches are
retained. Windows native commands now enter a kill-on-close Job Object before dispatch, including
detached descendants and owner death. Unix native commands retain process-group limits.
Optional strict container execution provides a separate PID namespace, scoped task-tree
mount and protected lifecycle guard. See [GAP-007](gap-reports/GAP-007.md) for evidence,
configuration and the explicit native/container dependency and service boundaries.
