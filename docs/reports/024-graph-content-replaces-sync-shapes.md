---
summary: >
  Step HS of CN master plan 282, server half: `POST /admin/sync-shapes` and the env boot flags
  `LINKED_SYNC_SHAPES_ON_BOOT`/`LINKED_SYNC_ONTOLOGIES_ON_BOOT` are removed; a host (Create Now,
  `LINKED_GRAPH_WRITER=host`) reads an app's graphs through `POST /admin/graph-content` (with
  `reload`) and writes them itself; an open-source app's routed boot sync is switched by
  `linked.config` `syncShapesOnBoot` alone. CN half and the decision ledger: CN report 289.
---

# 024 — Graph content replaces sync-shapes

## PR

### Summary

The server no longer writes an app's graphs on a host's request. `POST /admin/sync-shapes` is gone
(it answers 404); a host that writes the graphs itself asks `POST /admin/graph-content {packages?,
reload?}`, which reloads the named packages first (dev) and answers each graph's exact text and
hash without writing. The boot sync no longer reads `LINKED_SYNC_SHAPES_ON_BOOT` or
`LINKED_SYNC_ONTOLOGIES_ON_BOOT`: it runs when the app writes its own graphs
(`LINKED_GRAPH_WRITER=app`, the default) and `linked.config` does not set `syncShapesOnBoot:
false`; the ontology sync follows the same switch. Create Now switches to the new route in the same
landing (CN report 289).

### Changes

- `src/utils/adminChannel.ts`: the `/admin/sync-shapes` route, the `syncShapes` handler,
  `parseSyncShapesBody`, `ShapeSyncResult` and the `skipped: 'host-writer'` answer removed; the
  header lists the routes that remain; graph-content's reload rules are described there.
- `src/shapes/LinkedServer.tsx`: `resyncShapes` and its wiring removed; `bootSyncs()` (writer and
  config switch) used by the ontology phase, the shape sync and the targets log line; the
  one-at-a-time queue and its timeout (`LINKED_SHAPE_SYNC_TIMEOUT_MS`) kept for graph content,
  `reloadPackages` shared with it; under `host` the boot logs that the host writes the graphs.
- `src/utils/ontologySync.ts`: `shapeSyncOn(configFlag)` reads only the config switch;
  `bootSyncsOntologies` folded into it; `syncOntologiesThenShapes` (only `resyncShapes` called it)
  removed.
- Comments in `graphTargets.ts`, `syncShapes.ts`, `reloadSource.ts`; `readme.md` (Host control
  channel, Graph writer and graph content, Ontology sync and the shape check, Shape graphs, Which
  datasets the syncs write to) to the current state.
- `.changeset/graph-content-replaces-sync-shapes.md` (minor): both removals and their
  replacements, and the removed exports; the pending SY changeset no longer says the route and the
  flags stay.
- Tests: `admin-channel` (the sync-shapes cases rewritten against graph-content, a case that the
  route answers 404 with and without the secret; `parseGraphContentBody` replaces
  `parseSyncShapesBody`; the two cases about the ontology sync's answer of sync-shapes removed);
  `graph-writer` (boot and graph content: under `app` the boot sends graph queries and graph content
  none, `syncShapesOnBoot: false` sends none at boot, under `host` none at boot or on graph content,
  which still reloads); `boot-ontology-sync` (one switch case replaces the two env cases; the three
  `syncOntologiesThenShapes` cases removed); `graph-content` (`reload` reloads, registers again
  without syncing, names the packages); `shape-graphs-live` (the control-channel step reads
  graph-content: its hashes equal what the boot recorded); `graph-sync-live` (the second run is a
  second boot); `admin-routes`, `graph-query-plane` (handler stub dropped).
- `docs/backlog/005-unknown-shape-answers-invalid-query.md`: a query naming a shape outside the
  request's catalog answers 400 `Invalid query` (found by CN's spec for backlog 279).

### Verification

From `packages-local/_linked-server` of the step worktree, against the master's built core:

- `npx linked build`: `✔ Build successful` (6.2 s).
- `npm test`:
  ```
  Test Suites: 2 skipped, 37 passed, 37 of 39 total
  Tests:       2 skipped, 522 passed, 524 total
  Time:        10.168 s
  ```
- Live suites (Fuseki on :3030; `NODE_OPTIONS=--experimental-vm-modules npx jest --config
  jest.config.cjs src/tests/shape-graphs-live.test.ts src/tests/graph-sync-live.test.ts`):
  ```
  first boot (ontology phase + shape sync) 665 ms, second 41 ms
  Test Suites: 2 passed, 2 total
  Tests:       2 passed, 2 total
  Time:        3.066 s
  ```
  No `server-shape-graphs-*`/`server-graph-sync-*` dataset left behind.
- `grep -rn "sync-shapes\|LINKED_SYNC_SHAPES_ON_BOOT\|LINKED_SYNC_ONTOLOGIES_ON_BOOT" src readme.md`:
  only `src/tests/admin-channel.test.ts` (the case that the route is gone).

### Deviations

- `reload` stays a list of package names (as SY built it), not `reload: true` as plan 001 §HS
  wrote it: the list carries the allow-list check and says what to reload.
- graph-content answers no `shapes` IRI list and no `shapeCheck` (sync-shapes did); CN reads the
  node shapes out of the graph text it writes, and the shape check stays in the app's log.

### Follow-ups

- An unknown shape answers `Invalid query`: `docs/backlog/005-unknown-shape-answers-invalid-query.md`.
- `@_linked/core` backlog 068 (the default ontology mode's prune) is unchanged by this step.

## Details

The decision ledger of the whole step is in CN report 289 (`## Details`); rows 1–5 are this half's.
