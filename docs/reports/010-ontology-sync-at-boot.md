---
summary: >
  Before its shape sync, at boot and on `POST /admin/sync-shapes`, the server writes the class
  hierarchy (`rdfs:subClassOf`) of every registered package's ontology data into its app data
  (core `syncOntologies`, skipped per package by a content hash) and runs core's shape check,
  logging its findings. The route answers the packages the sync wrote and skipped and the
  check's counts. The server's own ontology data is Turtle, and `autoLoadOntologyData` is gone.
---

# 010 — Ontology sync and the shape check in the server

Part of CN plan 070 (the store infers; ontology data in every app dataset), §Control route.

## Why

The store infers RDFS classes from the `rdfs:subClassOf` triples in each dataset. Those triples
come from the packages' ontology data (Turtle, `src/data/*.ttl`), and only the app process
loads every package the app uses, so the app writes them, as it writes its shapes. The shape
check compares the registered shapes with the same hierarchy: a published package is checked
at build, a running app logs what it finds and is never stopped by it.

## What

### Boot

`initOnlyBoot` and `startBoot` run, after the backend providers are indexed and before
`materializeShapesIntoStore()`, `syncOntologiesOnBoot()` (as the system):

1. **Ontology sync** into `LinkedStorage.getDefaultDataset()` (skipped without one), every
   registered package, no `packages` filter, `orphanScope` passed explicitly: the shape sync's
   policy, `'none'` unless `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true`. It follows the shape sync's
   switch (`syncShapesOnBoot`, `LINKED_SYNC_SHAPES_ON_BOOT`), plus the opt-out
   `LINKED_SYNC_ONTOLOGIES_ON_BOOT=false` (boot only). One log line names the packages written
   and skipped.
2. **In-memory class hierarchy:** when the sync did not run (off, no dataset, or failed), core's
   `loadOntologyHierarchy` is called if core exports it (`@_linked/core/ontology/hierarchy`,
   checked at run time). When the sync runs, core's sync loads it itself.
3. **Shape check:** `checkShapeHierarchy({dependencies})`, the map built by
   `readDependencyLists` (`src/utils/linkedDependencies.ts`) from the app's `package.json` and
   every discovered linked package's (`dependencies` + `peerDependencies`). One summary line,
   then one warning line per finding.

A failure of either is logged and the boot goes on; `/admin/health` answers once the server
listens, after all three syncs.

### `POST /admin/sync-shapes`

Inside the existing queue, `withTimeout` (`LINKED_SHAPE_SYNC_TIMEOUT_MS`, 120 s) and
`runAsSystem`: reload the named packages (dev) → ontology sync (the shape sync's switch; the
body's `packages` never filters it) → shape check → shape sync. The answer gains
`ontologies: {written, skipped}` and `shapeCheck: {errors, warnings}`. A failed ontology sync
(store unreachable) does not stop the shape sync; the route then answers 500 with the ontology
error, the route's existing error path. A package whose data cannot be read is in `skipped`
with core's warning.

### Files

- `src/utils/ontologySync.ts` (new): `shapeSyncOn`, `bootSyncsOntologies`, `loadOntologyCore`
  (dynamic imports of core's server-only subpaths), `runOntologyPhase`,
  `syncOntologiesThenShapes` (the route's order and failure handling).
- `src/shapes/LinkedServer.tsx`: `syncOntologiesOnBoot`, `runOntologyPhase`, `resyncShapes`
  through `syncOntologiesThenShapes`; `autoLoadOntologyData(true)` and its import removed
  (core already discarded the data, so nothing changes).
- `src/utils/adminChannel.ts`: `ShapeSyncResult.ontologies`, `.shapeCheck`; docs.
- `src/data/server.json` → `src/data/server.ttl` (the same 16 triples: 4 `rdfs:Class`, no
  `subClassOf`); `src/ontologies/server.ts` exports `dataFiles` and a `loadData` through
  core's `loadOntologyFiles` (the JSON import and its `@ts-ignore` are gone);
  `server.register.ts` passes `dataFiles`.
- Tests: `boot-ontology-sync.test.ts` (new), `admin-channel.test.ts` (the new fields, a failed
  ontology sync), `ontology-prefix.test.ts` (Turtle data). `readme.md` §Host control channel
  and §Ontology sync and the shape check.

## Verification

Baseline (`store-inference` 0c295cd, before any change), quick gate `npm test`:

```
FAIL src/tests/two-copies.test.ts
Test Suites: 1 failed, 27 passed, 28 total
Tests:       390 passed, 390 total
npm test  75.17s user 25.74s system 266% cpu 37.828 total
```

`two-copies.test.ts` fails to run on `main` as well (the main checkout, same command):
`Error: Module cache already has entry …/_linked-core/lib/esm/utils/linkedError.js. This is a bug
in Jest, please report it!`. It is the jest 30 / Node 22.23 module-cache crash of core backlog 060
(`jest.isolateModulesAsync` loading a second copy), which is where its fix is tracked; no test in
it runs, before or after this change.

Phase 1 (Turtle data), quick gate and build:

```
Test Suites: 1 failed, 27 passed, 28 total
Tests:       390 passed, 390 total
npm test  70.57s user 21.67s system 269% cpu 34.255 total
✔ Build successful
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build  8.26s user 1.08s system 91% cpu 10.236 total
$ ls lib/esm/data
server.ttl
```

Phase 2 (sync and check), quick gate:

```
Test Suites: 1 failed, 28 passed, 29 total
Tests:       404 passed, 404 total
npm test  73.01s user 22.81s system 288% cpu 33.162 total
```

Full gate (`npm test && node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build && ls lib/esm/data`),
after the rebase onto `store-inference` (0c295cd, unchanged since the branch was cut):

```
FAIL src/tests/two-copies.test.ts
Test Suites: 1 failed, 28 passed, 29 total
Tests:       404 passed, 404 total
npm test  62.92s user 28.00s system 98% cpu 1:32.26 total
✔ Build successful
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build  9.76s user 2.39s system 30% cpu 39.704 total
server.ttl
```

**Verify.** A plain-JS test app (`linkedPackage('v1-verify-app')` with one ontology,
`v1verify:Dog rdfs:subClassOf v1verify:Animal` in Turtle, plus `@_linked/server`'s own
ontology), `new LinkedServer({server: {apiOnly: true}}).start()` on port 4178, default dataset
a `FusekiStore` on a throwaway `tdb2` dataset of a throwaway Fuseki (`secoresearch/fuseki:6.2.0`,
compose project `v1-verify`, port 3178), resolved through the step's worktree set (K1's core).

First boot:

```
22:00:50.275 [linked] indexed backend providers of 4 linked package(s) in 43ms; installed ones with providers: @_linked/server-utils, @_linked/server
22:00:50.929 [LinkedServer] ontology sync: written @_linked/server, v1-verify-app; skipped none
22:00:50.945 [LinkedServer] shape check: 0 error(s), 0 warning(s)
22:00:53.464 [LinkedServer] synced shapes into app-data with orphanScope 'none': 10 shape(s) written, no store shapes deleted (set LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true to prune)
22:00:53.468 Up and running at http://localhost:4178
22:00:53.802 health: {"status":"ok"}
```

Second boot:

```
22:00:56.262 [LinkedServer] ontology sync: written none; skipped @_linked/server, v1-verify-app
22:00:56.265 [LinkedServer] shape check: 0 error(s), 0 warning(s)
22:00:56.304 [LinkedServer] synced shapes into app-data with orphanScope 'none': 0 shape(s) written, no store shapes deleted (set LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true to prune)
22:00:56.308 Up and running at http://localhost:4178
22:00:56.691 health: {"status":"ok"}
```

`POST /admin/sync-shapes` with `{}` (0.11 s; `shapes` shortened):

```
{"written": 0, "orphanScope": "none", "ontologies": {"written": [], "skipped": ["@_linked/server", "v1-verify-app"]}, "shapeCheck": {"errors": 0, "warnings": 0}, "reloaded": [], "shapes": "11 shapes"}
```

The stored hierarchy (`SELECT ?s ?o WHERE { ?s rdfs:subClassOf ?o }` on the dataset):

```
https://example.org/v1verify/Dog,https://example.org/v1verify/Animal
```

Boot with `LINKED_SYNC_ONTOLOGIES_ON_BOOT=false` (no ontology sync line):

```
22:01:05.053 [linked] indexed backend providers of 4 linked package(s) in 18ms; installed ones with providers: @_linked/server-utils, @_linked/server
22:01:05.087 [LinkedServer] shape check: 0 error(s), 0 warning(s)
22:01:05.215 [LinkedServer] synced shapes into app-data with orphanScope 'none': 0 shape(s) written, no store shapes deleted (set LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true to prune)
22:01:05.221 Up and running at http://localhost:4178
22:01:05.537 health: {"status":"ok"}
```

After `v1verify:Puppy rdfs:subClassOf v1verify:Dog` was appended to the running app's Turtle,
`POST /admin/sync-shapes` wrote only the changed package:

```
{"written": 0, "orphanScope": "none", "ontologies": {"written": ["v1-verify-app"], "skipped": ["@_linked/server"]}, "shapeCheck": {"errors": 0, "warnings": 0}, "reloaded": []}
https://example.org/v1verify/Puppy,https://example.org/v1verify/Dog
https://example.org/v1verify/Dog,https://example.org/v1verify/Animal
```

The test app loads no shape with a finding, so the check's logging of findings is covered by
`boot-ontology-sync.test.ts` only. Core's `loadOntologyHierarchy` was not on `store-inference`
when this landed, so the boot's hierarchy load is skipped at run time (asserted by the test that
imports the real core).

## Notes for consumers

- CN's host calls `/admin/sync-shapes` with a 60 s timeout (`ChildProcessProvisioner.ts`)
  against the app's 120 s; the ontology sync adds a parse of every package's Turtle and, for a
  changed package, its writes (C3 owns the host side).
- Until N1, N2 and P1 land, every unconverted JSON package is skipped with core's warning,
  twice per run (once by the sync, once by the check); the boot of an app that loads the
  framework's ontology packages logs the framework's open findings.
- Core's range (`^2.36.0`) rises to the release carrying `syncOntologies` at the release.
