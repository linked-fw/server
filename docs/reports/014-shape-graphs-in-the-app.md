---
summary: >
  Shape graphs in the app: the boot and `POST /admin/sync-shapes` run core's `syncShapeGraphs`
  instead of the default-graph shape sync. An installed package's graph comes from its built
  `lib/esm/data/shapes.ttl` (none without it, nothing generated); the app's own packages are
  generated in process, in dev through Vite's loader; the app's single-owner shapes go in
  `{DATA_ROOT}/graph/shapes`. The boot logs the graphs written, a second boot skips them, and the
  route reports them as `shapeGraphs`. `graph-not-routed` and unknown graph refusal codes answer
  400. CN plan 071, step V2.
packages: [server]
---

# 014 — Shape graphs in the app

## Plan-mode detail (CN plan 071 §V2 is the sub-plan)

**Contract:** §Shape graphs as landed in core report 052 (`syncShapeGraphs(ds, {turtleFor,
appShapes: {graph, package?}, packages?, orphanScope?})`, `packageShapesTurtle(pkg)` is what `linked
build` writes, cli report 026); open question 6 (owner, 2026-10-23): an installed package without
`shapes.ttl` gets no shape graph and no generation; K4's `graph-not-routed` (core report 051).

**Files:** `src/utils/syncShapes.ts` (rewritten: where each package's Turtle comes from, the app
graph IRI, the dev generator, the sync and its log line), `src/shapes/LinkedServer.tsx` (boot and
`resyncShapes` through it; workspace package names; package directories), `src/utils/adminChannel.ts`
(`ShapeSyncResult.shapeGraphs`), `src/utils/queryPlane.ts` (refusal status map), readme.
Tests: `boot-shape-sync` (rewritten), `graph-query-plane` (two codes), `shape-graphs-live`
(new, `[fuseki]`).

**Phases:** 1. The refusal code, the sync module and the boot/re-sync wiring. 2. The live test
(boot, second boot, control route) and the readme. 3. Real app boot (Verify), changeset, backlog,
this record, landing.

**Pitfalls:** core's `turtleFor` returning `undefined` means "generate", so a package without the
file is left out through `packages`, which turns off core's orphan pruning (backlog 003). The dev
generator must be the core the SSR graph registered the source shapes on (`ssrLoadModule` of
`@_linked/core/shapes/shapesToTurtle`). CN boots with `syncShapesOnBoot: false`, so `:4040` is
unaffected.

## What

- **Where a package's Turtle comes from** (`shapeTurtleSource`): an installed package uses
  `lib/esm/data/shapes.ttl` from the directory discovery found it in (else the one the app
  resolves); without the file it has no shape graph and is left out of the sync (`packages`). The
  app's own packages (the app and its workspace packages) are generated in dev, even when a built
  file exists (the source is what runs); in a built app they use their file when there is one, else
  are generated in process. Reading of the plan: "an installed package" is a dependency, not the
  app's own code, which has no `linked build` file in a built app (`linked build-app`).
- **Dev generation** (`viteShapesTurtleGenerator`): `packageShapesTurtle(name)` from
  `@_linked/core/shapes/shapesToTurtle` loaded through `vite.ssrLoadModule`; a failure is logged and
  the sync's own core generates instead (same registry through `sharedState`).
- **App graph** (`appShapesGraph`): `{DATA_ROOT}/graph/shapes` (trailing slashes trimmed), recorded
  with the app's package name; no `DATA_ROOT` (or not an absolute IRI), no app graph.
- **The sync** (`syncShapeGraphsInto`) runs as the system at boot (as the ontology phase does) and
  inside `resyncShapes`' system run, after the ontology phase. One log line, e.g. `[LinkedServer]
  shape graph sync: written …; skipped …; app graph written; graphs written …; N default-graph
  shape(s) removed; no shapes.ttl (no shape graph): …`; on a store without graph queries `[LinkedServer]
  shape sync (default graph: the store has no graph queries): N shape(s) written`.
- **Control route**: `ShapeSyncResult.written` counts the shape graphs written (or the
  default-graph writes); `shapeGraphs` = `{written, skipped, pruned, graphs, appGraph: {graph,
  status}, withoutTurtle, cleaned, defaultGraph?}`.
- **Refusals**: `graph-not-routed` → 400; a code the map does not know → 400 (own-property lookup,
  so a code like `constructor` cannot pick up a prototype member).
- Readme §Shape graphs; changeset `shape-graphs-in-the-app.md` (minor, breaking list); backlog 003.

## Deviations

- None from §V2. Choice inside it: the app's own packages in a built app read their built file or
  are generated (above). Orphan pruning is skipped with a warning while any registered package has
  no `shapes.ttl` (core API; backlog 003).

## Verification

Worktree `~/web/wt/v2` (`npx linked doctor resolve`: `@_linked/server` overlay, core and
server-utils from the main checkouts, core `200037d`, cli `e75a12b`). Own Fuseki
`ghcr.io/linked-fw/fuseki:6.2.0-2` on :3185, compose project `fuseki-071-v2`; env
`FUSEKI_BASE_URL=FUSEKI_ADMIN_URL=http://localhost:3185`, `FUSEKI_TEST_PORT=3185`,
`CN_TEST_PORT=4185`, exported from a sourced file before every run.

Baseline `npm test`: `Test Suites: 17 failed, 15 passed, 32 total`, `Tests: 218 passed` — every
failure is the typecheck of `queryPlane.ts:246` (`Property '"graph-not-routed"' is missing … in
type 'Record<GraphQueryErrorCode, number>'`), plus `two-copies`.

Quick gates:

- Phase 1: boot-shape-sync, graph-query-plane, admin-channel, boot-ontology-sync → `Test Suites:
  4 passed`, `Tests: 71 passed, 71 total`, 5.2 s wall; `tsc -p tsconfig-tests.json --noEmit` clean.
- Phase 2: shape-graphs-live, boot-shape-sync, admin-channel, graph-sync-live → `Tests: 38
  passed, 38 total`, 4.8 s wall; typecheck clean.

Full gate (see also §Landing):

```
FAIL src/tests/two-copies.test.ts        (Jest worker exceptions; backlog 002 item 4)
Test Suites: 1 failed, 32 passed, 33 total
Tests:       455 passed, 455 total
Time:        22.135 s
npm test  69.07s user 19.41s system 376% cpu 23.478 total
✔ Writing shapes.ttl - lib/esm/data/shapes.ttl
✔ Build successful
npx linked build  10.48s user 1.07s system 174% cpu 6.633 total
```

**Verify (master §V2): the boot logs the graphs written, a second boot skips them; the control
route reports shape graphs.**

1. `shape-graphs-live.test.ts` (`[fuseki]`, fresh TDB2 dataset on :3185): the boot's own methods
   (`syncOntologiesOnBoot`, `materializeShapesIntoStore`) on a `LinkedServer` with fixture packages:
   `server-sg-built` (installed, `shapes.ttl` = `packageShapesTurtle`), `server-sg-bare`
   (installed, no file), `server-sg-own` (workspace package), core and the server as installed
   packages without the file. A default-graph shape of the built package written beforehand is
   removed; the bare one's stays. Second boot: **0 updates**. Then `POST /admin/sync-shapes`
   through `registerAdminRoutes` → `resyncShapes`.

   ```
   [LinkedServer] shape graph sync: written server-sg-built, server-sg-own; skipped none; app graph written; graphs written https://linked.cm/pkg/server-sg-built/graph/shapes, https://linked.cm/pkg/server-sg-own/graph/shapes, https://sg-app.test/data/graph/shapes; 1 default-graph shape(s) removed; no shapes.ttl (no shape graph): @_linked/core, @_linked/server, server-sg-bare
   [LinkedServer] shape graph sync: written none; skipped server-sg-built, server-sg-own; app graph skipped; no shapes.ttl (no shape graph): @_linked/core, @_linked/server, server-sg-bare
   first boot (ontology phase + shape sync) 201 ms, second 57 ms
   ✓ the boot writes and logs the shape graphs, a second boot writes nothing, the route reports them (531 ms)
   ```

   It also asserts the `ShapesGraph` records (`feedsHierarchy false`, `contentHash`, `package`),
   the built package's shapes in its graph, `core:generatedShape` links in the app graph, no graph
   and no record for the packages without the file, and the route's `written: 0` and full
   `shapeGraphs`.

2. **A real app process, in dev.** A clone of `linked-fw/app-template` (scratch directory), its
   `node_modules` linked to CN's with `@_linked/server` overlaid by this worktree (built with the
   integration cli, so its `lib/esm/data/shapes.ttl` exists), plus a source-only workspace package
   `packages-local/v2check` (two shapes, one `contains` property, no `lib/`). `linked start` with
   `PORT=4285`, `FUSEKI_BASE_URL=FUSEKI_ADMIN_URL=http://localhost:3185`, `FUSEKI_DATASET=v2-boot`,
   `DATA_ROOT=http://localhost:4285/data`, `CN_APP_ADMIN_SECRET` set.

   First boot (fresh dataset; 5 s from start to `Up and running`):

   ```
   [LinkedServer] ontology sync: written @_linked/core, @_linked/fuseki, @_linked/schema, @_linked/server, @_linked/server-utils, @_linked/xsd; skipped none; graphs written https://linked.cm/pkg/core/graph/ontology, …
   [LinkedServer] shape check: 0 error(s), 0 warning(s)
   [LinkedServer] shape graph sync: written @_linked/server, v2check; skipped none; app graph written; graphs written https://linked.cm/pkg/server/graph/shapes, https://linked.cm/pkg/v2check/graph/shapes, http://localhost:4285/data/graph/shapes; no shapes.ttl (no shape graph): @_linked/core, @_linked/schema
   Up and running at http://localhost:4285
   ```

   Quads per shape graph afterwards: `v2check` 23, `server` 13, app graph 132. `v2check` was
   generated through Vite's loader (no fallback warning); `@_linked/server` came from its file;
   core and schema (no file in this layout) got nothing.

   Second boot (5 s to `Up and running`):

   ```
   [LinkedServer] ontology sync: written none; skipped @_linked/core, @_linked/fuseki, @_linked/schema, @_linked/server, @_linked/server-utils, @_linked/xsd
   [LinkedServer] shape check: 0 error(s), 0 warning(s)
   [LinkedServer] shape graph sync: written none; skipped @_linked/server, v2check; app graph skipped; no shapes.ttl (no shape graph): @_linked/core, @_linked/schema
   ```

   `POST /admin/sync-shapes` (0.19 s):

   ```
   {"written": 0, "orphanScope": "none", "shapeGraphs": {"written": [], "skipped": ["@_linked/server", "v2check"], "pruned": [], "graphs": [], "withoutTurtle": ["@_linked/core", "@_linked/schema"], "cleaned": 0, "appGraph": {"graph": "http://localhost:4285/data/graph/shapes", "status": "skipped"}}}
   ```

   Note: a property added to `v2check`'s shape and `{packages: ["v2check"]}` gave `reloaded:
   ["v2check"]` but no new graph: the reload re-imports a package's `/backend` entry, which the
   fixture does not have, so its shape module was not re-evaluated. Existing behaviour of the
   reload, unchanged here (a CN clone's packages load their shapes from their backend).

## Landing

See the end of this record after the rebase.

## Follow-ups

- Backlog [003](../backlog/003-shape-graph-pruning-with-packages-without-turtle.md): orphan pruning
  while a package has no `shapes.ttl` (core's `turtleFor` cannot skip a package).
- R2: raise `@_linked/core` to the release with `shapes/syncShapeGraphs`; every package with shapes
  re-published so its tarball ships `data/shapes.ttl` (until then those packages get no shape
  graph in an app).
- C4: CN's catalogs read `graphs.allShapes` plus the app graph `{DATA_ROOT}/graph/shapes`.
