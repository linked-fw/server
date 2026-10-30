---
date: 2026-10-30
summary: >
  `@_linked/server` gained boot syncs that follow the storage routing, the writer flag
  `LINKED_GRAPH_WRITER=app|host` and the read-only `POST /admin/graph-content`; `POST
  /admin/sync-shapes` and the env boot flags are removed. Done; two minor changesets.
---

# 025 — Hub imports: server

## PR

### Summary

An app's graphs are written either by the app or by the host that runs it, never both:

- **Open-source app** (`LINKED_GRAPH_WRITER=app`, the default): the boot's ontology and shape
  syncs write each package's graphs into every dataset the app's storage routing needs them in,
  through `@_linked/core`'s routed syncs. `linked.config` `syncShapesOnBoot: false` is the one
  switch that turns both boot syncs off.
- **Hosted app** (`LINKED_GRAPH_WRITER=host`): the app writes no shape or ontology graph. The host
  asks `POST /admin/graph-content {packages?, reload?}`, which reloads the named packages first
  (dev) and answers each graph's exact text and hash without writing; the host writes them.

`POST /admin/sync-shapes` and the env flags `LINKED_SYNC_SHAPES_ON_BOOT` /
`LINKED_SYNC_ONTOLOGIES_ON_BOOT` are removed (breaking, shipped as a minor).

### Changes

- `src/utils/graphTargets.ts`: `GRAPH_WRITER_ENV`, `graphWriterFromEnv`, `appWritesGraphs(env)`
  (the one predicate every write path checks); `syncTargetsLine` (one boot line naming the target
  datasets per graph kind, only when routing goes beyond the default dataset) replaces
  `syncPinWarning`; `SHAPE_SHAPE_CLASSES`/`ONTOLOGY_TERM_CLASSES` moved to
  `@_linked/core/shapes/syncTargets`.
- `src/utils/syncShapes.ts`: `shapeTurtleSources` (the per-package Turtle choice, shared),
  `syncRoutedShapeGraphs` (per-dataset log lines, `datasets`, `prunedGraphs`, `leftovers`; a failed
  dataset fails the run after the others synced), `graphContentOf`; `syncShapeGraphsInto(ds)` kept
  for one given dataset.
- `src/utils/ontologySync.ts`: `runOntologyPhase(ds, {routed: true})` runs core's
  `syncOntologiesRouted`; `shapeSyncOn(configFlag)` reads only the config switch, which also
  governs the ontology sync.
- `src/shapes/LinkedServer.tsx`: both boot paths routed; the writer flag checked in `initStores`
  (fatal on a bad value); `bootSyncs()` (writer and config switch) drives the ontology phase, the
  shape sync and the targets line; `graphContent()` runs in the one-at-a-time queue with its
  timeout (`LINKED_SHAPE_SYNC_TIMEOUT_MS`), sharing `reloadPackages`; under `host` the boot logs
  that the host writes the graphs.
- `src/utils/adminChannel.ts`: `POST /admin/graph-content`, `parseGraphContentBody`,
  `AdminConflictError` (409), `GraphContentAnswer`; `/admin/sync-shapes`, the `syncShapes`
  handler, `parseSyncShapesBody`, `ShapeSyncResult` removed; the header lists the remaining
  routes. `src/utils/effectiveRoutes.ts`: `graphWriter` in `GET /admin/routes`.
- README: Host control channel, Graph writer and graph content, Ontology sync and the shape check,
  Shape graphs, Which datasets the syncs write to.
- Tests: new `graph-writer.test.ts`, `graph-content.test.ts`; routed cases in
  `boot-shape-sync.test.ts` (one on core's real routed sync with two datasets) and
  `boot-ontology-sync.test.ts`; `graph-targets.test.ts` (the `syncPinWarning` cases replaced by
  `syncTargetsLine` cases for the same situations, plus sub-shapes); `admin-channel.test.ts`
  (sync-shapes cases rewritten against graph-content, a case that the old route answers 404);
  `shape-graphs-live` and `graph-sync-live` read graph content / boot twice.
- Changesets: `.changeset/graph-writer-and-routed-boot-sync.md` (minor: routed boot sync, writer
  flag, graph content); `.changeset/graph-content-replaces-sync-shapes.md` (minor: removal of
  `/admin/sync-shapes`, the two env flags, `ShapeSyncResult`, `parseSyncShapesBody`, the
  `syncShapes` handler, `syncOntologiesThenShapes`, `bootSyncsOntologies`).

### Verification

- Report 023 (routed boot, writer flag, graph content): `linked build` → `✔ Build successful`;
  `npm test` → `Test Suites: 2 skipped, 37 passed, 37 of 39 total`, `Tests: 2 skipped, 525 passed,
  527 total`; live suites → `Test Suites: 2 passed, 2 total`, `Tests: 2 passed, 2 total`; after the
  fix round, touched suites `Tests: 76 passed, 76 total`.
- Report 024 (removals), the last full suite: `npx linked build` → `✔ Build successful` (6.2 s);
  `npm test` → `Test Suites: 2 skipped, 37 passed, 37 of 39 total`, `Tests: 2 skipped, 522 passed,
  524 total` (10.168 s); live suites (Fuseki on :3030) → `first boot (ontology phase + shape sync)
  665 ms, second 41 ms`, `Test Suites: 2 passed, 2 total`, `Tests: 2 passed, 2 total`; `grep -rn
  "sync-shapes\|LINKED_SYNC_SHAPES_ON_BOOT\|LINKED_SYNC_ONTOLOGIES_ON_BOOT" src readme.md` → only
  `src/tests/admin-channel.test.ts` (the case that the route is gone).

### Deviations

- `reload` is a list of package names, not a boolean: the list carries the allow-list check and
  says what to reload.
- `graph-content` answers no `shapes` IRI list and no `shapeCheck`: the host reads the node shapes
  out of the graph text, and the shape check stays in the app's log.
- The single-dataset helpers (`syncShapeGraphsInto(ds)`, `runOntologyPhase(ds)` without `routed`)
  stay, for syncing one given dataset.

### Follow-ups

- A query naming a shape outside the request's catalog answers 400 `Invalid query`:
  `docs/backlog/005-unknown-shape-answers-invalid-query.md`.
- `'default'` ontology mode leaves a moved package's terms: `@_linked/core` backlog 068.

## Details

### Contract: writer flag and graph content (K3 in the hosting application's plan 282)

- **`LINKED_GRAPH_WRITER`** = `app` (default) or `host`; any other value stops the boot, naming the
  variable. Parsed in `initStores` next to the graph targets; read through
  `appWritesGraphs(env)` at every write path. Under `host` the app writes no shape or ontology
  graph: the boot registers ontologies, loads the hierarchy and runs the shape check but syncs
  nothing. `GET /admin/routes` adds `graphWriter: 'app' | 'host'`.
- **Boot sync** runs when `appWritesGraphs(env)` and `linked.config` `syncShapesOnBoot` is not
  `false`; the ontology sync follows the same switch. `LINKED_SYNC_SHAPES_PRUNE_ORPHANS` stays (an
  open-source boot prune; no effect under `host`).
- **`POST /admin/graph-content`** on the admin channel, behind `requireAdmin`, body `{packages?:
  string[], reload?: string[]}` (`reload`: packages reloaded from disk first, dev only, refused for
  `@_linked/*`; ontologies are registered again and the shape check runs, without syncing), in the
  one-at-a-time queue and timeout, writing nothing. Answer `{graphTargets, packages: [{name,
  shapes?: GraphContent, ontology?: GraphContent}], appGraph?: GraphContent | null, withoutTurtle:
  string[], unreadable: string[], reloaded: string[]}` with `GraphContent = {graph, mediaType:
  'text/turtle' | 'application/n-triples', text, hash, sources: string[]}`: `text` and `hash` are
  exactly what the `'package'`-mode sync would write and record (`shapeGraphHash(text)`,
  `ontologyGraphHash(raw texts)`); `sources` the record's `dcterms:source`. Without `packages`,
  every registered package with shapes or ontology data; 400 on an invalid name. `appGraph` is
  `null` when the app has no single-owner shapes (the host drops the graph) and absent without
  `DATA_ROOT`. When a graph target (`LINKED_SHAPE_GRAPH`, `LINKED_ONTOLOGY_GRAPH`) is not
  `'package'`, 409 naming it. The content comes from `@_linked/core`'s `graphContent()`; the server
  adds the Turtle source choice, `graphTargets` and `reloaded`.
- An ontology graph's content is N-Triples of all the package's data files and its hash covers the
  raw file texts: a host stores the answered `hash`, never one recomputed from `text`.
- `/admin/graph-registry-changed` stays (a host calls it after writing).

### Contract: routed boot sync (K4)

The targets, prune and failure rules are `@_linked/core`'s (its report 088, "Contract: routed sync
targets"). On the server: both boot paths (`initOnlyBoot` and the full boot) call the routed syncs;
a failed dataset is logged after the others synced and the boot keeps its non-fatal warning;
`syncTargetsLine` is silent without pins.

### Decisions that shaped it

- One predicate gates every write path, so a new write path cannot miss the flag; env stays the
  one source, as for the graph targets.
- Graph content is a POST because it may reload changed source first; it lives in the shape sync's
  queue so it never computes during a reload.
- The host is the only writer for hosted apps; the request-time write route went with no window in
  which a host calls a route the server no longer has (the host switched in the same landing).
- Open-source apps keep exactly one boot switch, `syncShapesOnBoot`.

### Step reports

| Report | What it covers |
|---|---|
| [023 — Graph writer, graph content, and boot syncs that follow routing](023-graph-writer-and-graph-content.md) | Routed boot syncs, `LINKED_GRAPH_WRITER`, `POST /admin/graph-content`, `syncTargetsLine`; ledger in `@_linked/core` report 084 |
| [024 — Graph content replaces sync-shapes](024-graph-content-replaces-sync-shapes.md) | `/admin/sync-shapes` and the env boot flags removed; `reload` through graph content |

### At release

- Release `@_linked/core` first: the server imports `@_linked/core/shapes/syncTargets`, new in that
  core minor, while its `@_linked/core` range is still `^2.45.0`; the release raises the range to
  the published core.
