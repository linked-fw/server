---
summary: >
  Sub-plan of Create Now master plan 282 (shapes and packages per hub) for `@_linked/server`: the
  boot sync follows the storage routing (K4, from core), a hosted app gets the writer flag
  `LINKED_GRAPH_WRITER=host` and a read-only graph content endpoint (K3) in step SY (planned in
  core plan 006); step HS later removes `/admin/sync-shapes` and the old boot flags. Lands on
  master `hub-imports`.
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
  graph also where shapes targeting its classes route; the single-owner graph to the datasets of
  shapes declaring `contains` properties ∪ the NodeShape/PropertyShape dataset. Prune only in the
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

## HS — server half (placeholder)

Removes `POST /admin/sync-shapes` (and `resyncShapes`' write path, `parseSyncShapesBody`,
`ShapeSyncResult`'s sync fields), the boot flags `LINKED_SYNC_SHAPES_ON_BOOT` /
`LINKED_SYNC_ONTOLOGIES_ON_BOOT` and what replaces them for hosted apps, together with CN's switch
to K3 (cross-repo pair, M5). Report `docs/reports/024-…`. Detailed when wave 2 starts.

## Progress

- [x] SY — server half (report 023; see core plan 006).
- [ ] HS — server half (report 024).
