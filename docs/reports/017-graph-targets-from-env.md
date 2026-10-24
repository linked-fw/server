---
summary: >
  LINKED_ONTOLOGY_GRAPH / LINKED_SHAPE_GRAPH fill core 2.41's graph targets on the stores at boot
  (checked; an invalid value is a fatal boot error); GET /admin/routes reports the targets and the
  variables; logs and the shape report follow the mode; the probe's temporary graphs are left out
  of the ontology phase's report.
packages: [server]
---

# 017 — Graph targets from the environment

## PR

### Summary

Core 2.41.0 gives stores two graph targets, `ontologyGraph` and `shapeGraph` (`package`, `default`
or a shared graph IRI), and never reads `process.env` for them. The server does:

- `initStores` reads `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH`
  (`applyGraphTargetsFromEnv`, `src/utils/graphTargets.ts`), before any store is initialised. An
  invalid value (or one that clashes with a store's own targets) is a `FatalStartupError` naming the
  variable, so the boot ends instead of hanging. Each store registered in `LinkedStorage` that takes
  graph targets gets them where its own options leave them unset (`onlyUnset`). A store that takes
  none (`RemoteDataset`) runs `package`, with a warning when the variables ask for another mode.
- `GET /admin/routes` adds `ontologyGraph` / `shapeGraph` per dataset (when the store has them) and
  `graphTargetEnv` (the variables as set), so a host can check the mode.
- The ontology phase's log names a shared graph or the default graph when the sync wrote there
  (core's `target` / `fallback`). The shape report sets `target` (and `fallback`), lists the shared
  graph as the one graph written, logs packages left out of a shared graph, and logs `'default'`
  mode apart from a store without graph queries.
- The ontology phase's `graphs` / `droppedGraphs` leave out graphs the run created and dropped (the
  inference probe's temporary graphs), which the live test showed listed as written.
- `@_linked/core` ^2.41.0. Readme: "Ontology and shape graphs" under Environment Variables, the
  routes answer, the shape sync's modes.

### Verification

Worktree `gmode`, against `@_linked/core` 2.41.0 (the main checkout pulled and built), own Fuseki
`ghcr.io/linked-fw/fuseki:6.2.0-2` on :3318, `FUSEKI_BASE_URL=http://localhost:3318`.

```
npx linked build      ✔ Build successful
npm test              FAIL src/tests/two-copies.test.ts   (backlog 002 item 4, as before)
                      Test Suites: 1 failed, 34 passed, 35 total
                      Tests:       476 passed, 476 total
npx tsc -p tsconfig-tests.json   0 errors
```

New tests: `graph-targets.test.ts` (fill and keep, invalid values, stores without targets, the
routes answer, the fatal boot error before any `init()`), `boot-shape-sync.test.ts` (default and
shared modes in the report and log), `boot-ontology-sync.test.ts` (`graphsWrittenAndDropped`, the
log per mode). The live tests (`graph-sync-live`, `shape-graphs-live`) pass on the inferring store.

### Deviations

- The probe-graph fix in the ontology phase's report was not asked for; the live test failed
  without it on any core since 2.39.4.

### Review

An independent read-only review found three medium findings, all fixed: an invalid variable now
throws a `FatalStartupError` (a plain rejection did not end the process); the shared-mode log no
longer says "no app shapes" without `DATA_ROOT` (core always writes them into the shared graph); and
packages left out of a shared graph are logged and warned about instead of the package mode's
"not pruned" warning. Low ones applied: the store-conflict error names the variables, `fallback` is
reported, the readme lists every refused value and says which stores get the targets, and the test
restores `LinkedStorage`'s default dataset.

### Follow-ups

- None in this repo. CN reads the new routes fields (CN report on graph modes).
