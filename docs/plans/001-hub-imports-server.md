---
summary: >
  Sub-plan of Create Now master plan 282 (shapes and packages per hub) for `@_linked/server`: the
  boot sync follows the storage routing (K4, from core), a hosted app gets the writer flag
  `LINKED_GRAPH_WRITER=host` and a read-only graph content endpoint (K3) in step SY (planned in
  core plan 006); step HS removes `/admin/sync-shapes` and the old boot flags (detailed below).
  Lands on master `hub-imports`.
status: Plan
---

# 001 — Hub imports: server

## Master plan

[CN plan 282](../../../../docs/plans/282-shapes-and-packages-per-hub.md) —
`/Users/rene/web/wt/hub-imports/docs/plans/282-shapes-and-packages-per-hub.md` (decisions, rules
for every step, status table, numbers, starter prompt). Steps land on master `hub-imports`
(`/Users/rene/web/wt/hub-imports/packages-local/_linked-server`, branch `hub-imports`).

## Contracts

Copied verbatim from plan 282; the rest are there. A step that changes one updates it here, in
core plan 006 and in 282 in the same landing. Core plan 006 §Contracts holds K3's full wording
(accepted by the master, 282 M9) and K4's names (M10–M12).

- **K3 Hosted-app writer flag and graph-content endpoint** (provider SY in `@_linked/server`; consumer
  HS; M9): `LINKED_GRAPH_WRITER=app|host` (under `host` the app writes no shape or ontology graph,
  at boot or on request); `POST /admin/graph-content {packages?, reload?}` on the admin channel
  returns, without writing, per package its shapes and ontology graphs and the app's single-owner
  graph, each `{graph, mediaType, text, hash, sources}` (the exact bytes and hash the package-mode
  sync writes); `appGraph` null when the app has none, absent without `DATA_ROOT`; 409 when a graph
  target is not `package`. `/admin/sync-shapes` and `LINKED_SYNC_*_ON_BOOT` stay until HS (M5);
  under `host`, `/admin/sync-shapes` reloads but answers `skipped: 'host-writer'`; `/admin/routes`
  reports `graphWriter`. Exact text in core sub-plan 006 §Contracts.
- **K4 Open-source sync targets** (provider SY in `@_linked/core`; consumer `@_linked/server`'s boot
  sync; M10–M12): `graphSyncTargets()`, `syncShapeGraphsRouted`, `syncOntologiesRouted` in core
  `src/shapes/syncTargets.ts`. A package's graphs go to every dataset any of its shapes route to ∪
  the dataset NodeShape/PropertyShape (and the ontology term shapes) are pinned to (G2); an ontology
  graph also where shapes targeting its classes route; the single-owner graph to every dataset any
  shape it constrains routes to (the shapes declaring `contains` properties and their sub-shapes) ∪
  the NodeShape/PropertyShape dataset, the same text everywhere (M19). Prune only in the
  app's default dataset (M11). Per-dataset `syncShapeGraphs(ds)`/`syncOntologies(ds)` unchanged.

## SY — server half

SY is one step across core and server; its full section (goal, scope, files, pitfalls, tests,
verify, phases) is [core plan 006 §SY](../../../_linked-core/docs/plans/006-hub-imports-core.md#sy--sync-follows-routing-hosted-app-writer-flag-and-graph-content-endpoint),
and the step agent's own plan doc is core `docs/plans/007-sync-follows-routing.md`. Report here:
`docs/reports/023-graph-writer-and-graph-content.md`. The server's part:

- **Boot follows routing (D12, K4):** `LinkedServer.materializeShapesIntoStore` /
  `syncRegisteredShapes` (~529–563) and `syncOntologiesOnBoot` / `runOntologyPhase` (~597–625), in
  both boot paths (~501–503, ~866–868), and `resyncShapes` (~649–675) call core's routed syncs
  instead of syncing into `LinkedStorage.getDefaultDataset()`; `syncShapeGraphsInto`
  (`src/utils/syncShapes.ts` ~217) and `runOntologyPhase` (`src/utils/ontologySync.ts` ~166) report
  per target dataset; `warnOfSyncPins` / `syncPinWarning` (`src/utils/graphTargets.ts` ~114) give
  way to one log line naming the targets; `SHAPE_SHAPE_CLASSES` / `ONTOLOGY_TERM_CLASSES` move to
  core.
- **K3 writer flag:** parsed at boot beside `applyGraphTargetsFromEnv`; one predicate gates the
  boot syncs and `resyncShapes`; `GET /admin/routes` (`effectiveRoutes.ts`) reports it.
- **K3 endpoint:** on `registerAdminRoutes` (`src/utils/adminChannel.ts` ~181), behind
  `requireAdmin`, in `resyncShapes`'s queue and timeout, writing nothing.
- **Kept (M5):** `/admin/sync-shapes`, `LINKED_SYNC_SHAPES_ON_BOOT`,
  `LINKED_SYNC_ONTOLOGIES_ON_BOOT`, `linked.config` `syncShapesOnBoot`.
- **Tests, new:** `src/tests/graph-writer.test.ts` (flag parsing; under `host` no graph query at
  boot or on sync-shapes; routes report it), `src/tests/graph-content.test.ts` (admin secret
  required; 400 on a bad name; body equals what the `app` writer stores; 409 under a non-package
  graph target; `appGraph` null and absent cases; `reload` refused for `@_linked/*`), a case in
  `boot-shape-sync.test.ts` and `boot-ontology-sync.test.ts` for a pinned package written into both
  datasets. **Existing, must stay green:** `boot-shape-sync`, `boot-ontology-sync`,
  `graph-targets` (its `syncPinWarning` cases are replaced, not deleted silently: the report names
  them), `admin-channel`, `admin-routes`, `shape-graphs-live`, `graph-sync-live`.
- **Verify:** `npm test`; the live suites with `FUSEKI_BASE_URL=http://localhost:3030`;
  `npx linked build`. README §admin channel (~474) and §boot syncs (~504–517) updated.

## HS — server half

Plan-mode detail found on server b5f0781 (line numbers there; re-find with `spai`). One step with
the CN half ([CN plan 283 §HS](../../../../docs/plans/283-shapes-and-packages-per-hub-cn.md));
the server lands first in the same step, then CN's switch (M5: no window where CN calls a route
the server no longer has). The step starts after CN step VD (283 §HS, "The catalog gap").

- **Depends on:** SY (K3, K4 as built, report 023). Consumer: CN's HS half.
- **Goal:** D20 and M5 on the server side: an app CN hosts is told `LINKED_GRAPH_WRITER=host` and
  only answers `POST /admin/graph-content`; the request-time write route and the two env boot
  flags go. An open-source app (writer `app`, the default) keeps its routed boot sync (K4, D12).
- **Scope:**
  1. **Remove `POST /admin/sync-shapes`**: the route (`src/utils/adminChannel.ts:295`), its
     handler slot `syncShapes` in the admin handlers (:159), `parseSyncShapesBody` (:207),
     `ShapeSyncResult` (:60) and the `skipped: 'host-writer'` answer; in
     `src/shapes/LinkedServer.tsx` the wiring (:1040-1043) and `resyncShapes` (:674-700, the
     host branch :679-683 included). The reload it did stays reachable through
     `POST /admin/graph-content {reload: true}` (`graphContent`, :704; `reloadPackages` shared).
     The header comment of `adminChannel.ts` (:11-31) lists the routes that remain.
  2. **Remove the env boot flags** `LINKED_SYNC_SHAPES_ON_BOOT` and
     `LINKED_SYNC_ONTOLOGIES_ON_BOOT`: `shapeSyncOn` (`src/utils/ontologySync.ts:109`) reads only
     the `linked.config` switch `syncShapesOnBoot`; `bootSyncsOntologies` (:120) follows it (no
     separate ontology opt-out). Callers `LinkedServer.tsx:547, 598-599, 621, 685`. The boot sync
     runs when `appWritesGraphs(env)` (`src/utils/graphTargets.ts:66`) and the config switch is not
     `false`. `syncTargetsLine`/the host log (`LinkedServer.tsx` ~586-591) say "host writes the
     graphs" under `host`.
  3. **Kept:** `LINKED_GRAPH_WRITER=app|host` (`GRAPH_WRITER_ENV`, :39; `graphWriterFromEnv` :52,
     fatal on a bad value in `initStores` :1106-1108), `/admin/graph-content`, `/admin/routes`
     (`graphWriter`, `src/utils/effectiveRoutes.ts:51`), `/admin/graph-registry-changed` (CN calls
     it after writing), `LINKED_SYNC_SHAPES_PRUNE_ORPHANS` (an open-source boot prune; no effect
     under `host`), the `syncShapesOnBoot` config key (`_linked-cli` `src/interfaces.ts:114`,
     unchanged), the single-dataset helpers (S9).
  4. **README:** "Host control channel" (:462-497: the sync-shapes row and text go,
     graph-content's `reload` described as the way to reload), "Graph writer and graph content"
     (:500-539: current state, the "stays until HS" line goes), "Ontology sync and the shape
     check" (:542-550) and "Shape graphs" (:552-568: the boot switch is `syncShapesOnBoot` and the
     writer), "Which datasets the syncs write to" (:570-595).
  5. **Changeset**: minor (M5 is a removal of a route and two env flags; the plan's semver rule
     ships small breaking framework changes as minors), naming both removals and the replacement.
- **Verify** (from the step's `packages-local/_linked-server` worktree, after the master's core is
  built): `npx linked build`; `npm test`; live suites `FUSEKI_BASE_URL=http://localhost:3030 npx
  jest src/tests/shape-graphs-live.test.ts src/tests/graph-sync-live.test.ts` (own datasets
  only); `grep -rn "sync-shapes\|LINKED_SYNC_SHAPES_ON_BOOT\|LINKED_SYNC_ONTOLOGIES_ON_BOOT" src
  README.md` shows nothing but the changeset and history.
- **Done when:** no route `/admin/sync-shapes`; no env read of the two flags; under `host` no graph
  query at boot and `graph-content {reload: true}` reloads and answers; under `app` the routed
  boot sync runs unless `syncShapesOnBoot: false`; README and changeset current; report 024.
- **Files found in code:** `src/utils/adminChannel.ts` (:11-31, :60, :159, :207, :224, :295),
  `src/shapes/LinkedServer.tsx` (:199-204 imports, :531-700, :1040-1043, :1106-1108),
  `src/utils/ontologySync.ts` (:104-125), `src/utils/graphTargets.ts` (:66, :82-84),
  `src/utils/syncShapes.ts` (unchanged: `graphContentOf` :578), `README.md`, `.changeset/`.
- **Pitfalls:**
  - **Open-source apps** lose two env opt-outs; `syncShapesOnBoot: false` in `linked.config` is
    the one switch left (`semantu-webid-email` sets `true`, CN sets `false`: neither changes).
  - **Tests that set the flags** (`shape-graphs-live.test.ts:26` deletes
    `LINKED_SYNC_SHAPES_ON_BOOT`; `boot-ontology-sync.test.ts:90-104` tests the boot switch)
    change to the config switch and the writer; the report names each replaced case.
  - **CN's own process** reads the same two names for its cn-main sync
    (`linked.backend.storage.js:433/440`); CN's half renames them (`CN_SYNC_*_ON_BOOT`). The
    server change does not affect CN's cn-main sync, which never ran through the server.
- **Tests:** changed: `src/tests/admin-channel.test.ts` (sync-shapes cases :49 and
  `parseSyncShapesBody` :190 removed, a case that the route answers 404), `graph-writer.test.ts`
  (:89-129: no sync-shapes under `host`; reload through graph-content), `boot-ontology-sync.test.ts`
  (:90-104: the config switch, no env flag), `boot-shape-sync.test.ts` (same),
  `graph-content.test.ts` (`reload: true` reloads, as sync-shapes did). Must stay green:
  `graph-targets`, `admin-routes`, `shape-graphs-live`, `graph-sync-live`.
- **Size and phases:** small–medium, one phase of the HS step (its phase 1). Report
  `docs/reports/024-…`.

## Progress

- [x] SY — server half (report 023; see core plan 006).
- [x] HS — server half (report 024; with CN report 289).
