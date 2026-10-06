---
'@_linked/server': major
---

Remove the in-memory shape index and the endpoints that served it.

- `indexShapesIntoMemory` and the `utils/Shapes` module are gone (including its re-exports of
  `ShapeDetails`, `PropertyDetails`, `getShapeIndex` and `getShapeFromIndex`, which
  `@_linked/server-utils` 2.0.0 also removes). The server no longer builds the index at boot.
- `LincdServerBackendProvider.getShapes()` is removed.
- `LincdAPI.get_all_shapes` (`GET /api/all-shapes`) and `LincdAPI.get_shape_details`
  (`GET /api/shape-details`) are removed, and with them the `GET /api/:method` mount, which
  served nothing else. `LincdAPI` keeps its `POST /api/...` query routes. The unused
  `ShapeSummary` type is removed.

Why: the shape catalog lives in the store (SHACL, projected to core's `NodeShapeWire`), and
nothing reads the in-memory index any more. The index was also lossy: complex property paths
(sequences, alternatives, inverses) were stored as an empty id, so it could not describe the
shapes it listed.

Migration: read shapes from the store, or from core's registry for compiled shapes, typed as
`NodeShapeWire` / `PropertyShapeWire` from `@_linked/core/shapes/nodeShapeWire`. Requires
`@_linked/server-utils` ^2.0.0.
