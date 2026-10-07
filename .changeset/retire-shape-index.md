---
'@_linked/server': minor
---

Remove the in-memory shape index and the endpoints that served it.

This release removes public API but is published as a minor version on purpose, because no linked package uses it any more. If you still do, see the migration notes below.

Removed:

- `indexShapesIntoMemory()` and the `@_linked/server/utils/Shapes` module. The module's re-exports of `ShapeDetails`, `PropertyDetails`, `getShapeIndex` and `getShapeFromIndex` go with it, and `@_linked/server-utils` 1.12.0 removes those too. The server no longer builds the index when it starts.
- `LincdServerBackendProvider.getShapes()`.
- `LincdAPI.get_all_shapes` (`GET /api/all-shapes`), `LincdAPI.get_shape_details` (`GET /api/shape-details`) and the `ShapeSummary` type.
- The `GET /api/:method` route, which served only those two endpoints. `LincdAPI` keeps its `POST /api/...` query routes.

**Behaviour change:** `LincdAPI` no longer answers unmatched `GET /api/*` requests. They now go to the app's own routes and, if none matches, to the SPA shell.

Why: shape metadata is stored as SHACL, and nothing reads the in-memory index any more. The index was also lossy: it stored complex property paths (sequences, alternatives, inverses) as an empty id.

Migration:

- Instead of calling `GET /api/all-shapes`, `GET /api/shape-details` or `getShapes()`, read shapes from your store, or from core's registry for compiled shapes (for example `getNodeShape(id)` from `@_linked/core/utils/ShapeClass`).
- Type shape metadata as `NodeShapeWire` / `PropertyShapeWire` from `@_linked/core/shapes/nodeShapeWire`.

Requires `@_linked/server-utils` ^1.12.0.
