---
summary: >
  Step SY of CN master plan 282, server half: the boot syncs and POST /admin/sync-shapes follow
  the storage routing through core's routed syncs; LINKED_GRAPH_WRITER=app|host (under host the
  app writes no graph); POST /admin/graph-content answers each graph's exact text and hash without
  writing (K3). Core half and the decision ledger: core report 084.
---

# 023 — Graph writer, graph content, and boot syncs that follow routing

## PR

### Summary

The server's boot ontology and shape syncs, and `POST /admin/sync-shapes`, now write each package's
graphs into every dataset the app's routing needs them in (core's routed syncs, K4; core report
084). A hosted app can be told to write no shape or ontology graph (`LINKED_GRAPH_WRITER=host`) and
to answer their content instead (`POST /admin/graph-content`, K3), so CN can become the only
writer (step HS). `/admin/sync-shapes` and `LINKED_SYNC_*_ON_BOOT` stay (M5).

### Changes

- `src/utils/syncShapes.ts`: `shapeTurtleSources` (the Turtle choice, shared), `syncRoutedShapeGraphs`
  (one log line per dataset when there are several, `datasets`, `prunedGraphs`, `leftovers`; a
  failed dataset fails the run after the others synced), `graphContentOf`; `syncShapeGraphsInto(ds)`
  kept for one given dataset; `ShapeGraphCore` gains `syncShapeGraphsRouted`, `graphContent`.
- `src/utils/ontologySync.ts`: `runOntologyPhase(ds, {routed: true})` runs core's
  `syncOntologiesRouted`, observes every dataset, reports `datasets`, `prunedGraphs`, `leftovers`;
  a failed dataset is the phase's `failure`.
- `src/utils/graphTargets.ts`: `syncPinWarning` and the moved constants replaced by
  `syncTargetsLine` (one boot line naming the datasets per graph kind, only when routing goes beyond
  the default dataset); `GRAPH_WRITER_ENV`, `graphWriterFromEnv`, `appWritesGraphs`.
- `src/shapes/LinkedServer.tsx`: both boot paths and `resyncShapes` routed; the flag checked in
  `initStores` (fatal on a bad value) and gating every write path; under `host` sync-shapes answers
  `{written: 0, skipped: 'host-writer', reloaded, shapes, shapeCheck}`; new `graphContent()` in the
  shape sync's queue and timeout (409 unless both graph targets are `package`); shared
  `inShapeSyncQueue`, `reloadPackages`.
- `src/utils/adminChannel.ts`: `POST /admin/graph-content`, `parseGraphContentBody`,
  `AdminConflictError` (409), `GraphContentAnswer`; `skipped: 'host-writer'`.
  `src/utils/effectiveRoutes.ts`: `graphWriter`.
- Tests: new `graph-writer.test.ts` (5), `graph-content.test.ts` (6); routed cases in
  `boot-shape-sync.test.ts` (3, one on core's real routed sync with two datasets) and
  `boot-ontology-sync.test.ts` (2); `graph-targets.test.ts`: the four `syncPinWarning` cases
  replaced by `syncTargetsLine` cases for the same situations, plus the sub-shape case.
- README: admin table (`graph-content`, `graphWriter`, sync-shapes fields), "Graph writer and graph
  content", "Which datasets the syncs write to", ontology and shape sync sections. Changeset (minor)
  `.changeset/graph-writer-and-routed-boot-sync.md`. Plan 001: contracts as accepted, SY ticked.

### Verification

From `/Users/rene/web/wt/hub-imports--sy/packages-local/_linked-server`, after core's build:

- `linked build`: `✔ Build successful`.
- `npm test`: `Test Suites: 2 skipped, 37 passed, 37 of 39 total`, `Tests: 2 skipped, 525 passed,
  527 total` (the two live suites skip without Fuseki env).
- Live suites, `FUSEKI_BASE_URL=http://localhost:3030` (their own datasets):
  `shape-graphs-live.test.ts graph-sync-live.test.ts` → `Test Suites: 2 passed, 2 total`,
  `Tests: 2 passed, 2 total`.
- `tsc -p tsconfig-tests.json --noEmit`: one error, `src/shapes/LincdWebApp.ts:23` (two core
  copies in the worktree install), the same as before the change.
- CN typecheck and Vitest: see core report 084 (0 errors with one core copy; 15/15 Vitest).

### Deviations

- The single-dataset helpers (`syncShapeGraphsInto(ds)`, `runOntologyPhase(ds)` without `routed`)
  stay for syncing one given dataset (S9).
- Under `host`, sync-shapes leaves `ontologies` out of its answer, per K3's wording (S14).

### Follow-ups

- Step HS: CN sets `LINKED_GRAPH_WRITER=host`, reads `POST /admin/graph-content`, and removes
  `/admin/sync-shapes` and the boot flags (server plan 001 §HS, M5).
- The rest: core report 084 §Follow-ups.

## Details

The decision ledger (S1–S18) is in core report 084 §Details: the step's one plan doc was core's
plan 007. Local data: nothing stored changes shape; no reset needed.

## Addendum: fix round (master decision M19)

The app's single-owner graph also follows sub-shapes of the shapes declaring `contains` (core
report 084 §Addendum). `syncTargetsLine` names those datasets for the app shape graph; README and
K4 in plan 001 updated. Touched suites: `Tests: 76 passed, 76 total`.
