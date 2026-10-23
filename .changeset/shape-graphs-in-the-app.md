---
'@_linked/server': minor
---

Shape graphs in the app. The boot and `POST /admin/sync-shapes` sync the registered shapes with
core's `syncShapeGraphs`: each package's shapes in its own named graph
(`{package IRI}/graph/shapes`, a `ShapesGraph` record in the graph registry), skipped when the
stored content hash matches. An installed package's graph comes from its built
`lib/esm/data/shapes.ttl`; the app's own packages (the app and its workspace packages) are
generated in process, in dev through Vite's loader; the app's single-owner shapes go in
`{DATA_ROOT}/graph/shapes`. The boot logs the graphs it writes, and the route reports them as
`shapeGraphs`. A graph refusal `graph-not-routed`, and any graph refusal code the server does not
know, is answered 400.

Breaking changes:

- The default-graph shape sync is replaced: shapes are written into shape graphs, and the shapes an
  earlier server wrote into the default graph are removed there once their package's graph holds
  them. A store without graph queries still gets the default-graph sync.
- An installed package without `lib/esm/data/shapes.ttl` gets no shape graph, and its shapes are
  not generated: packages need a release built with a cli that writes `shapes.ttl`.
- `ShapeSyncResult.written` (the route's `written`) counts the shape graphs written, not shapes;
  `shapeGraphs` holds the detail.
- `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true` drops the shape graphs of packages no longer registered
  (never the app's own graph), instead of default-graph node shapes; it is skipped, with a warning,
  while a registered package has no `shapes.ttl`.
- Requires `@_linked/core` `^2.39.0` (`shapes/syncShapeGraphs`, `shapes/shapesToTurtle`).

Deprecated: `materializeShapes` and `SyncShapesFn` in `utils/syncShapes` stay as they were, for
code built against an earlier server; `syncShapeGraphsInto` replaces them.

An own package whose shapes could not be generated (the dev loader failed and the server's core
holds none of them) is listed in `withoutTurtle`, with a warning, instead of being left out of the
report.
