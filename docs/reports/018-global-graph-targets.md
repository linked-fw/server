---
summary: >
  LINKED_ONTOLOGY_GRAPH / LINKED_SHAPE_GRAPH set core 2.42's one global graph-target setting at
  boot (setGraphTargets, once; an invalid value stays fatal); GET /admin/routes reports it as
  `graphTargets`; a boot warning names the synced shapes routing pins to another dataset (the
  syncs write into the default dataset only).
packages: [server]
---

# 018 — The graph targets are one global setting

## PR

### Summary

`@_linked/core` 2.42.0 (core report 075) made the graph targets one global setting of the process
(`setGraphTargets` / `getGraphTargets`) and removed every per-store path. The server follows:

- **Boot.** `initStores` reads `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH` and calls core's
  `setGraphTargets` once (`applyGraphTargetsFromEnv(env)`), before the boot initialises the stores
  and before the syncs, on both boot paths (`start`, `initOnly`). An invalid value is still a
  `FatalStartupError` naming the variable. Nothing is set on a store any more, and the "store takes
  no graph targets" warning is gone with the per-store targets.
- **`GET /admin/routes`** reports the setting as `graphTargets: {ontologyGraph, shapeGraph}` next to
  `graphTargetEnv`; the per-dataset `ontologyGraph` / `shapeGraph` fields are removed.
- **New boot warning (option 1).** The syncs write into the default dataset only. When routing
  pins `NodeShape` / `PropertyShape` or an ontology term shape (target class `rdfs:Class`,
  `owl:Class`, `rdf:Property`, `owl:ObjectProperty`, `owl:DatatypeProperty`,
  `owl:AnnotationProperty`, or a sub-shape of one) to another dataset, the boot logs one warning
  naming each shape and its dataset and saying the syncs go to the default dataset only
  (`syncPinWarning`, `src/utils/graphTargets.ts`).
- **Readme:** the mode is one global setting set by the host from the two variables, default
  `package`, no per-store settings, the frontend needs none; the syncs-to-default rule and its
  warning; the routes answer.
- `@_linked/core` ^2.42.0 (lockfile refreshed in a scratch copy: only the core entry changed).
  Changeset `graph-targets-are-global.md` (minor).

### Verification

Worktree `gglobal`, against `@_linked/core` 2.42.0 (the main checkout pulled and built), own
Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3322, `FUSEKI_BASE_URL=http://localhost:3322`.

```
npx linked build      ✔ Build successful
npm test              FAIL src/tests/two-copies.test.ts   (backlog 002 item 4, as before)
                      Test Suites: 1 failed, 34 passed, 35 total
                      Tests:       476 passed, 476 total
npx tsc -p tsconfig-tests.json   0 errors
```

`graph-sync-live` and `shape-graphs-live` pass on the inferring store. `graph-targets.test.ts`:
the env sets the global (unset is `package`), an invalid value is refused and leaves the setting,
the routes answer, the pin warning (direct pins of the shape shapes; an ontology term shape and
its sub-shape pinned through the parent; silent without such a pin), the fatal boot error before
any `init()`.

### Deviations

- The setting is applied at the start of `initStores`, not before the app's storage file builds
  its stores (that file runs before the server). Stores no longer read the setting when they are
  built; core reads it at sync and query time, so the order is safe.

### Review

An independent read-only review found no high finding and one medium: the readme still called the
shape sync's `target` "the store's `shapeGraph`" (fixed). Low, applied: sub-shapes of a watched
shape are reported (`owl:Restriction` under `owl:Class`), the function is documented to run
outside a shape catalog, the warning says "when they run", the readme and changeset say "before
the boot initialises the stores", and a test for an ontology term shape pinned through its
parent. Not applied: warning about graph routes on the default dataset (outside the decision).

### Follow-ups

- Core backlog 076: the sync follows routing (option 2).
- CN reads `graphTargets` (CN report on the global graph targets).
