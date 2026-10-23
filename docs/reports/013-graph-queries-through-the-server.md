---
summary: >
  Graph queries through the server: `RemoteDataset.graphQuery` (refusals back as
  `GraphQueryError`s, no method → `unsupported-query-kind`), the url form's graph-registry cache
  for `.from(graphs.allOntologies)` reads, the generic plane's `graphQuery` arm checked by
  `QueryAccess`'s `graph` rule with refusal codes on the wire, the control channel's
  `POST /admin/graph-registry-changed`, and an ontology phase that reports the graphs it wrote.
  CN plan 071, step V1.
packages: [server]
---

# 013 — Graph queries through the server

## Plan-mode detail (CN plan 071 §V1 is the sub-plan)

**Files:** `src/shapes/quadstores/RemoteDataset.ts` (graphQuery, registry cache, read expansion),
`src/utils/queryPlane.ts` (`toGraphQuery`, `authorizeGraphQuery`, `graphQueryCallError`),
`src/backend.ts` (`graphQuery` on the generic provider), `src/shapes/LinkedServer.tsx` (`code` in
error bodies; doc lines), `src/utils/adminChannel.ts` (the route), `src/utils/ontologySync.ts`
(graphs in the result and the log). Tests: `remote-dataset-graphs`, `graph-query-plane`,
`boot-ontology-sync` (extended), `graph-sync-live` (`[fuseki]`).

**Phases:** 1. `RemoteDataset.graphQuery` and its registry cache. 2. The plane's graph arm, refusal
codes, the control route. 3. The ontology phase's graphs, the live test, changeset, backlog,
review, landing.

**Wire for C1** (CN's gateway arm should answer the same way): method `graphQuery`, body
`{args: [GraphQuery]}`, result `GraphResult`; a refusal `{error, code}` with code ∈
`graph-exists` (409), `graph-not-registered` (409), `graph-name-read-only` (400),
`unsupported-query-kind` (501). `RemoteDataset` reads any graph code at any status as that
refusal, and a 404/501 without a code as `unsupported-query-kind` (today's gateway answers 404
`{error: 'not found'}`, so the app's sync falls back until C1 lands). The app's
`.from(graphs.allOntologies)` reads also select `OntologyGraph`/`ShapesGraph` records through the
gateway: C1's read rule should admit them (refused → the names go unexpanded, nothing breaks).

## What

- **`RemoteDataset.graphQuery`**: the plain query is posted like every other query (token,
  `x-linked-end-user`); no-url form through `Server.call`. Errors pass through
  `graphQueryFailure`: a graph code → `GraphQueryError(code)` (cause kept); 404/501 without a code
  → `unsupported-query-kind`; 401/403 stay `RemoteDatasetUnauthorizedError`. After success, core's
  `noteGraphQuery` updates the store's cache entry.
- **Registry cache (url form)**: `selectQuery`/`askQuery` expand `graphs.allOntologies` and
  `graphs.allShapes` through core's `readGraphRegistry` (one load: `OntologyGraph.select()` and
  `ShapesGraph.select()` through the store itself; 30-second expiry). Other names go as they are.
  A name expanding to nothing, or every name when the registry read fails (one warning), is sent
  unexpanded for the data server to resolve. Key: protected `graphRegistryKey()` =
  `{url}#{ping dataset}`, else per instance; `invalidateGraphRegistry(dataset?)` as on
  `SparqlDataset`. The no-url form sends `graphs` unchanged (the backend's store expands them).
- **Generic plane**: `LincdServerBackendProvider.graphQuery` (`@callable('public')`): `ir` =
  `parseGraphQuery(body)` or undefined; `checkQueryAccess({operation: 'graph', query, ir, …})`
  (no rule → 403, malformed → 400); then `LinkedStorage.graphQuery(ir)` (outside any catalog; no
  catalog is resolved for graph queries, so the check sees the same store). A `GraphQueryError`
  becomes a `ServerCallError` with status and `code`; `handleErrorsJson` now sends a string `code`
  of any `ServerCallError` as `{error, code}`. A store without `graphQuery` (published class built
  against an older core) is refused by core's runtime guard → 501 `unsupported-query-kind`.
- **`POST /admin/graph-registry-changed {dataset}`**: `requireAdmin` as the other routes (404
  without `CN_APP_ADMIN_SECRET`, 401 on a wrong secret), 400 without a dataset name, then
  `dropGraphRegistryCache` → core's `invalidateGraphRegistry()` **with no key**, answering
  `{invalidated: dataset}`. Choice (coordinator, 2026-10-23): the route must drop the entry the
  app's own stores use, whether `RemoteDataset` or `FusekiStore` (`{baseUrl}/{dataset}`). No store
  exposes its key or dataset name (the key is protected), and the stores are built by the app's
  storage config, whose aliases the server never sees; rebuilding a key string by hand was ruled
  out. So every entry is dropped: one registry read per cached dataset on its next expanding read.
  Targeted invalidation is backlog 002 item 2.
- **Ontology phase** (boot and `POST /admin/sync-shapes`): core's `syncOntologies` already holds
  the fallback (`unsupported-query-kind` → default-graph sync). The phase observes graph queries on
  the synced dataset (`subscribeQueryDispatch`, filtered by `target`), returns
  `ontologies.graphs` / `droppedGraphs` (optional fields, also on `ShapeSyncResult`) and logs them;
  with no graph query observed but packages written it logs "(default graph: the store has no
  graph queries)".
- Changeset `graph-queries-through-the-server.md` (minor, breaking list); backlog 002.

## Verification

Worktree `~/web/wt/v1` (`npx linked doctor resolve`: `@_linked/server` overlay; core
`9ce8b8f`, server-utils `e620452` from the main checkouts). Own Fuseki `linked-fuseki:071` on
:3178, compose project `fuseki-071-v1` (core's `src/tests/docker-compose.test.yml`), env
`FUSEKI_BASE_URL=FUSEKI_ADMIN_URL=http://localhost:3178`.

Baseline: `npm test` → `Test Suites: 5 failed, 24 passed, 29 total`, `Tests: 351 passed` (the five
fail typecheck: `RemoteDataset` lacks `graphQuery`).

Quick gates:

- Phase 1: remote-dataset-graphs, remote-dataset, remote-dataset-ask → `Tests: 53 passed, 53
  total`, `Time: 4.114 s` (5.6 s wall); `npx linked build` `✔ Build successful` (14.3 s).
- Phase 2: graph-query-plane, admin-channel, remote-dataset-graphs, query-plane-hardening,
  call-errors → `Tests: 71 passed` after fixes (`9 passed` for the new suite, 2.0 s); build ✔.
- Phase 3: boot-ontology-sync, admin-channel → `Tests: 43 passed, 43 total`.
- After the review fixes: remote-dataset-graphs, boot-ontology-sync, graph-query-plane →
  `Tests: 49 passed, 49 total`.

Full gate: see §Landing.

Verify (master §V1):

- *Boot against a throwaway store writes one graph per package; the route's second run skips
  all* — `graph-sync-live.test.ts` (`[fuseki]`): the ontology phase with a url-form
  `RemoteDataset` → the real generic plane → `LinkedStorage.graphQuery` on a fresh TDB2 dataset of
  :3178; second run through `POST /admin/sync-shapes` (`registerAdminRoutes` +
  `syncOntologiesThenShapes`). Log:

  ```
  [LinkedServer] ontology sync: written @_linked/core, server-graph-sync-a, server-graph-sync-b; skipped none; graphs written https://linked.cm/pkg/core/graph/ontology, https://linked.cm/pkg/server-graph-sync-a/graph/ontology, https://linked.cm/pkg/server-graph-sync-b/graph/ontology
  [LinkedServer] shape check: 0 error(s), 0 warning(s)
  [LinkedServer] ontology sync: written none; skipped @_linked/core, server-graph-sync-a, server-graph-sync-b
  [LinkedServer] shape check: 0 error(s), 0 warning(s)
  ✓ writes one graph per package with its record, then the route’s second run skips all (1254 ms)
  ```

  It also asserts the registry records (`OntologyGraph`, `feedsHierarchy true`, `package`), an
  empty default graph for the synced terms, and `ASK { ex:rex a ex:Animal }` true through a
  package graph's `subClassOf`. This is the boot's phase function over the real wire, not a full
  app process boot.
- *An app with `RemoteDataset` against a stub plane sends `graph_replace`* — remote-dataset-graphs
  "posts the graph query as is…"; graph-query-plane "RemoteDataset against the plane".
- *`/admin/graph-registry-changed` without the secret is refused, with it the next
  `.from(graphs.allOntologies)` read re-reads the registry (stub counts the registry selects)* —
  graph-query-plane "with the secret, the next .from(graphs.allOntologies) read re-reads the
  registry": registry reads 1 → 1 after the refused push (401) → 2 after the push.

Known red: `two-copies.test.ts` stops the jest worker ("Module cache already has entry
…/linkedError.js. This is a bug in Jest") — reproduced on `main`'s source (364d12f with a stub
`graphQuery`), core backlog 060's failure; backlog 002 item 4.

## Review

Independent read-only review (opus) of the diff against master §V1 and §Contracts. Verdict, quoted:

> Verdict: 0 high, 1 medium open. The plane's security, the admin route and the runtime guard are
> sound; the medium is a missing fallback when the client-side registry read fails, which is
> mechanical apart from whose identity that read should run under.

Fixed: the medium (a failed registry read sends the names unexpanded, one warning); low 2 (key
`{url}#{dataset}`); low 3 (only a 404/501 without a code maps to `unsupported-query-kind`); low 5
(the default-graph log needs an observer); low 6 (changeset breaking list: server-utils
requirement, the registry selects through the data server, `code` in error bodies). Recorded in
backlog 002 item 5: whose identity reads the registry (design), fork staleness of the key, bad
record fields answering 500 (core), the no-url form losing `code` over HTTP, observation by
target only.

Re-review of the fix commit (same reviewer), quoted:

> Verdict: 0 high, 0 medium open. V1 is ready to land once report 013 is added.

## Landing

After `git rebase named-graphs` (up to date; core `9ce8b8f`, fuseki `7081df7` with F2,
server-utils `e620452` are the integration tips), full gate with the live store:

```
FAIL src/tests/two-copies.test.ts        (Jest module-cache bug, backlog 002 item 4)
Test Suites: 1 failed, 31 passed, 32 total
Tests:       442 passed, 442 total
Time:        27.88 s
npm test  65.83s user 24.32s system 303% cpu 29.693 total
✔ Build successful
npx linked build  8.45s user 0.90s system 184% cpu 5.057 total
```

## Follow-ups

- Backlog [002](../backlog/002-graph-registry-cache-across-copies-and-keys.md): cache across two
  copies of core; targeted invalidation; `/api/*` graph arm; the Jest bug; review lows.
- C1: answer graph refusals as `{error, code}` (§Wire for C1); admit the registry record selects
  in the read rule; push `/admin/graph-registry-changed`.
- R1: raise `@_linked/core` and `@_linked/server-utils` ranges.
