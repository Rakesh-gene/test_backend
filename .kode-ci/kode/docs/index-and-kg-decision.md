# ADR-001: Indexing and knowledge graph

Status: selected architecture for implementation. Recorded 6 November 2026. Implementation, packaging, accuracy, and performance remain to be validated; this decision is not a benchmark result.

## Decision

| Responsibility | Selected technology |
| --- | --- |
| Code/document retrieval | XERJ, managed as a local process |
| Canonical structural and requirement/proof graph | Kode-owned typed node/edge schema in SQLite |
| Incremental syntax extraction and code chunk boundaries | Tree-sitter |
| Precise definitions/references where supported | SCIP ingestion from language-specific indexers |
| Agent access | Kode context API and read-oriented MCP facade |
| Default search pipeline | Exact symbol/path lookup, BM25 retrieval, bounded graph expansion and deterministic ranking |

Neural embeddings are not required by v1 and no separate vector database is selected. Later neural retrieval must pass relevance and portability checks and remain explicitly configured. XERJ's default embeddings are lexical feature hashing rather than neural embeddings; do not advertise them as semantic understanding. [XERJ usage reference](https://xerj.org/llms.txt)

XERJ is the selected retrieval engine, not a remaining candidate. Kode owns the graph rather than delegating code relationships or proof state to XERJ's memory/second-brain features. SQLite is an embedded graph representation with SQL traversal and application algorithms; it is not a claim to implement Cypher or a general-purpose graph database. [SQLite recursive graph queries](https://www.sqlite.org/lang_with.html)

## Why this combination

XERJ exposes local indexing, code-aware search, HTTP/MCP access, and an Apache-2.0 repository license. Its documented document graph does not supply the canonical compiler-resolved code and proof graph Kode requires. [Repository](https://github.com/xerj-org/xerj), [second-brain graph documentation](https://github.com/xerj-org/xerj/blob/main/docs/SECOND_BRAIN.md)

Tree-sitter supplies incremental syntax trees, including useful parsing when source contains errors. Parsing establishes structure, not complete name/type resolution. SCIP defines symbol occurrences and roles used for definitions/references; its actual coverage depends on each language indexer and project setup. A SCIP reference is not automatically a resolved runtime call. [Tree-sitter](https://tree-sitter.github.io/tree-sitter/), [SCIP documentation](https://sourcegraph.com/docs/code-navigation/writing-an-indexer)

Kode's graph must join code facts with its own requirements, tasks, assertions, and evidence. Owning this schema lets the workflow enforce provenance and snapshot identity without coupling those guarantees to a third-party memory API. An embedded graph avoids requiring a separate graph service in the initial cross-platform CLI.

## Extraction and indexing pipeline

1. Discover permitted roots; apply repository/workspace ignores and file limits. Exclude generated state, dependencies, caches, credentials, and Kode/XERJ storage by default. Report exclusions and language coverage.
2. Capture a root/worktree generation and file-content manifest. Hash content and identify changed, removed, or renamed files.
3. Parse changed supported files with Tree-sitter; extract files, scopes, declarations, imports, syntactic call sites, and symbol-sized chunks. Use overlapping bounded text chunks for unsupported source/doc formats, marked as text-only.
4. Import SCIP indexes for the matching project snapshot and enrich definitions/references. Index generation may require dependencies or build steps; invoke declared repo commands only under the run's permissions. Keep syntax-only operation available when semantic tooling is absent and report reduced precision.
5. Store facts, occurrence ranges, extraction versions, and provenance in SQLite under the unpublished generation. Publish Kode-generated search chunks to generation-specific XERJ indexes through its structured ingestion interface. Keep stable chunk IDs linking back to SQLite and source hashes.
6. Verify indexing completion and record a published context generation only when both stores are ready. Queries pin that generation, not whichever data is newest in either store. Interrupted generations stay unpublished and are recoverable or disposable.
7. Watch files with debounced updates, plus hash reconciliation to catch missed events and branch switches. Retire superseded facts and chunks on deletes/renames. Revalidate citations against actual source before editing.

Kode controls extraction and publication. XERJ autoindex can support an explicitly separate document corpus later, but it must not become a second unsynchronized extractor for the canonical code graph. The initial implementation may reindex an isolated generation in full; optimizations must preserve the same snapshot contract.

## Graph model

Code nodes: root/repository, package, module, file, symbol, endpoint, schema, and test. Workflow nodes: feature, requirement, task, assertion, proof execution, and evidence artifact.

Relations: contains, defines, imports, references, calls, exposes, consumes, implements, asserts, executes, and produces-evidence. Treat static call-site candidates and resolved targets distinctly. Dynamic dispatch, reflection, runtime route construction, and incomplete language analysis remain explicit limitations.

Every code fact includes root ID, context generation, root-relative path/range, source hash, extractor/version, and precision class. Every edge has supporting source/configuration or explicit workflow provenance. Use precision classes such as compiler-resolved, syntax-derived, configured, inferred, and unknown; numeric confidence is optional and must not imply calibrated certainty.

Canonical symbol identity uses language/package identity and version where available. Syntax-only IDs are scoped to a root and declaration; they are not guaranteed stable across moves or renames. Cross-repo edges need dependency/package identities, API/schema evidence, or explicit workspace bindings. Never join symbols or endpoints solely because their names match.

Store workflow/proof records durably in Kode state, logically distinct from rebuildable extracted code facts. Graph views reference immutable proof IDs and artifacts; rebuilding a code index cannot erase approval or evidence history. A proof applies to its recorded multi-root snapshot and approved spec/proof hashes, not to an arbitrary future graph generation.

## Worktrees and consistency

The [refresh policy](index-refresh-policy.md) is authoritative for existing local edits, agent writes, Git operations, refresh scheduling, query barriers, and proof invalidation. Index current permitted disk contents, including staged/unstaged changes and nonignored untracked files. Execution worktrees must materialize the run's captured dirty baseline rather than silently starting from HEAD alone.

Index identity is `(root ID, worktree ID, base revision, content generation, extractor/config versions)`. Multi-repo queries resolve a context manifest listing the exact generation for every participating root. Branch name alone is insufficient, and ordinary folders use content generations without Git revisions.

Start with isolated worktree generations. Share immutable extraction/chunk caches by content hash to reduce repeated work. Add base-plus-overlay storage only when measured need justifies it; overlay semantics must mask deleted/replaced files and their old incoming/outgoing edges. Queries must never combine another agent's uncommitted edits with the caller's worktree.

Tree-sitter facts update after edits; semantic enrichment becomes stale when the relevant source/dependency configuration changes. Retire stale semantic claims from the current view until refreshed. For uncertain dependency impact, invalidate the project-level SCIP enrichment. Historical generations remain available for audit but are never represented as current.

Use one writer coordinator per workspace, WAL-compatible reads where supported, and bounded update transactions. Serialize generation publication. Recovery reconciles SQLite metadata with XERJ contents and rebuilds missing derived indexes. No distributed transaction or atomic Git commit across repositories is assumed.

## Retrieval and agent tools

Expose `search`, `symbol`, `references`, `dependencies`, `impact`, `contracts`, and `evidence` through Kode, with root/worktree/generation scope resolved before querying a backend. Do not expose unrestricted raw backend queries to agents in v1.

Search exact names and paths first, retrieve BM25 chunks second, then expand relevant graph neighbors. Prefer precise definitions and matching contracts; deduplicate chunks and honor response/token budgets. Graph expansion has explicit depth, visited-node, result, and time limits with truncation flags. Cycles cannot create unbounded traversal.

Results include source citations, content hashes, generation, precision, coverage, freshness, and truncation status. An empty or incomplete graph result means no relationship was found within analyzed scope; it does not prove no relationship exists. For editing and proof selection, fall back to direct source inspection when graph coverage is insufficient.

The graph helps research specs, estimate impact, and select proof candidates. Actual test/UI executions establish behavioral evidence; graph reachability cannot prove acceptance criteria passed.

## Operations, platform support, and observability

Kode manages a version-pinned XERJ process with health checks and explicit shutdown ownership. Keep its storage outside indexed roots, use loopback access and supported authentication, and expose only Kode-scoped queries to agent sessions. Never widen agent read access through an unrestricted search backend. Do not automatically enable third-party sharing, external reranking, outbound embeddings, reference downloads, or feedback uploads.

Release artifacts and parser/indexer bindings must be validated on supported Windows, macOS, and Linux architectures. No Docker, WSL, GPU, or remote search service is required by the architecture. Exact binary/indexer compatibility is a release gate. Pin and track versions, checksums, licenses, and data-format migrations; user-owned source and evidence survive index rebuilds.

If XERJ is unavailable, expose a degraded direct text/symbol inspection path and recovery diagnostics. Do not silently build a second full search engine or call partial results complete. Graph reads can continue for a valid snapshot, with freshness clearly shown. Any scoped backend replacement requires a new ADR.

Instrument discovery, hashing, parsing, SCIP import, chunk ingestion, publication, search, and graph traversal with OpenTelemetry. Record generation IDs and precision/coverage in trace/log details, with bounded-cardinality metrics for latency, queue depth, stale roots, and errors. TUI context inspection shows each root's indexing state and semantic coverage.

## Alternatives and scope

- GitNexus is not a bundled dependency: Kode needs control of graph/proof provenance, and the current repository uses PolyForm Noncommercial rather than a permissive commercial-use license. [License](https://github.com/nxpatterns/gitnexus/blob/main/LICENSE)
- Neo4j or another standalone graph server is not required for the initial single-machine product. Revisit only if traversal/storage measurements exceed the embedded approach.
- Zoekt and SQLite FTS5 are not parallel default indexes. They remain possible future backend replacements if measured requirements justify a new decision.
- LLM-generated edges and summaries are optional interpretations, kept separate from structural facts and never used alone to establish proof or precise dependency coverage.

## Implementation order and validation gates

1. Implement snapshot/generation identity, SQLite schema, Tree-sitter extraction for TypeScript/JavaScript and Python, and XERJ ingestion/search. Unsupported languages remain text-searchable.
2. Add SCIP ingestion for supported initial projects; expose exact language/indexer coverage in diagnostics. Precise cross-repo references require compatible package identity and indexer support.
3. Add manifest/schema-backed cross-repo contracts, graph-assisted context packs, and requirement/assertion/evidence views.
4. Validate a representative small repo, monorepo, and connected API/client pair on all target OS families. Measure cold/warm indexing, single-file changes, RAM/disk, query latency, definition/reference accuracy, and impact recall against curated cases.
5. Require tests for two worktrees editing the same file differently, changed/deleted symbols, stale SCIP data, cross-repo version ambiguity, ignored/unreadable files, bounded cyclic traversal, crash during publication, interrupted backend ingestion, and citations that no longer match source.

These gates validate implementation of the selected stack. They do not leave the architecture open-ended. Reopen this ADR only for a demonstrated correctness, packaging, licensing, or performance blocker, documenting the replacement and migration plan.
