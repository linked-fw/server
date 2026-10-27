---
date: 2026-10-27
summary: >
  `POST /admin/sync-shapes` no longer answers 500 when only the shape check threw: the phase
  reports it as `shapeCheck.failed` and the route answers 200 when both syncs succeeded.
  `syncPinWarning` counts a sub-shape under the target class it declares itself (CN's
  `CatalogNodeShape` is no longer reported as `sh:NodeShape`); `owl:Restriction` is watched. The
  double hierarchy parse at boot needs a core change and stays in backlog 001. Patch. Step F of
  CN master plan 181.
---

# 021 — A thrown shape check, and the sync-pin warning's own target classes

## PR

### Summary

- **Thrown shape check (backlog 001 §1).** `runOntologyPhase` recorded a shape check that threw as
  the phase's `failure`, and `syncOntologiesThenShapes` rethrew it after the shape sync, so the
  host's re-sync answered 500 although both syncs had written. The check's error now goes into
  `shapeCheck.failed` (its message) and is logged as before; `failure` is the ontology sync's
  alone, which still fails the route (after the shape sync ran).
- **Sync-pin false positive (backlog 005).** `watchedClassOf` returned the first watched target
  class anywhere up the class chain, so a sub-shape with its own `targetClass` (CN's
  `CatalogNodeShape ⊑ NodeShape`, class `createNow:CatalogNodeShape`) was reported as
  `sh:NodeShape`. The walk now stops at the first class that declares `targetClass` itself; a
  sub-shape without one still counts under its parent's. `owl:Restriction` joins
  `ONTOLOGY_TERM_CLASSES`, so an `owl:Restriction` shape pinned elsewhere keeps being reported,
  now under its own class, as the backlog doc proposed.

### Changes

- `src/utils/ontologySync.ts`: `ShapeCheckSummary` (`errors`, `warnings`, `failed?`); the check's
  catch sets `shapeCheck.failed`; docs of `runOntologyPhase` and `syncOntologiesThenShapes`.
- `src/utils/adminChannel.ts`: `ShapeSyncResult.shapeCheck` is a `ShapeCheckSummary`.
- `src/shapes/LinkedServer.tsx`: `resyncShapes` doc.
- `src/utils/graphTargets.ts`: `watchedClassOf` stops at an own `targetClass`; `owl:Restriction`
  watched.
- Tests: `boot-ontology-sync.test.ts` (a throwing check: phase not failed, `shapeCheck.failed`
  set; `syncOntologiesThenShapes` resolves with it); `graph-targets.test.ts` (the restriction under
  `owl:Restriction`, a sub-shape without its own class under `owl:Class`, a `NodeShape` sub-shape
  with its own class not reported).
- Backlog 005 removed; 001 trimmed to the double parse (with what core lacks) and the stale `lib/`.

### Verification

```
$ npm test                                   # jest, the package suite
Test Suites: 2 skipped, 34 passed, 34 of 36 total
Tests:       2 skipped, 501 passed, 503 total
$ FUSEKI_BASE_URL=… npx jest src/tests/graph-sync-live.test.ts src/tests/shape-graphs-live.test.ts
Test Suites: 2 passed, 2 total
Tests:       2 passed, 2 total
$ npx linked build
✔ Build successful
```

CN on the worktree (`PORT=4067 APP_ADMIN_SECRET=… npm run start:local`), boot log
`[cn-main] ontology sync: 19 unchanged`, `[cn-main] shape graph sync: 4 unchanged`, no
`Routing pins` line; then:

```
$ curl -X POST -H 'x-app-admin-secret: …' localhost:4067/admin/sync-shapes
{'written': 0, 'skipped': 'disabled', 'ontologies': {'written': [], 'skipped': [], 'graphs': [], 'droppedGraphs': []}, 'shapeCheck': {'errors': 0, 'warnings': 0}, 'reloaded': []}
HTTP 200
```

(`shapes` left out of the quote.) `npm run test:regular` in the CN worktree: PASS, 342 passed / 14 skipped, 297 s (`## Details`).

### Deviations

- **The double hierarchy parse is not fixed.** Core exposes neither the sync's parsed triples nor
  an "use the in-memory hierarchy" option for `checkShapeHierarchy`, so parsing once needs a core
  change. Core is not in this step's scope and another step is changing core's ontology modules
  in the same wave; left in backlog 001 §1 with the change it needs.
- **The route answers 200, not an error status,** for a check that threw while both syncs
  succeeded: the error is in the body (`shapeCheck.failed`), as backlog 001 proposed. A failed
  ontology or shape sync still answers with its error.

### Follow-ups

- Parse the hierarchy once per boot (needs a core getter or option first): backlog 001 §1.
- A dev package built once registers from a stale `lib/`: backlog 001 §2.

## Details

The route's shape check counts are what the shape check found in CN at the time: none. The
admin re-sync in CN reports `skipped: 'disabled'` because CN runs its own per-dataset syncs with
the server's boot shape sync off; the ontology phase (and so the shape check) still runs there.


### CN regular set

`CN_TEST_PORT=4167 npm run test:regular` in the CN worktree (both packages linked from the step's
worktrees), under the shared lock, 297 s wall clock:

```
  14 skipped
  342 passed (4.0m)

test:regular
  typecheck:gate                                   PASS   14s
  unit (vitest)                                    PASS   38s
  packages                                         PASS    8s
  playwright (integration + sign-in e2e)           PASS  237s
  total                                            PASS  297s
```
