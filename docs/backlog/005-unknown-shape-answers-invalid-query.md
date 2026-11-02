---
summary: >
  A generic-plane query naming a shape the request's shape catalog does not hold answers 400
  `Invalid query`, the same answer as a malformed body. A host whose catalog follows a dataset's
  imports (Create Now) sees this whenever a client queries a shape its branch does not hold; the
  answer should name the cause (an unknown shape, 404 or 422 with the shape IRI), and the decode
  failure should be logged.
packages: [server]
---

# 005 — An unknown shape answers `Invalid query`

Source: CN plan 282 (step HS, report 289), CN backlog 279.

`toQueryBuilder` (`src/utils/queryPlane.ts`) decodes the client's DSL JSON with core's
`fromJSON(query, {catalog})` and turns every failure into `ServerCallError(400, 'Invalid query')`.
When `catalog` (the request's shape catalog, `resolveQueryCatalog`) has no shape of the query's
`shape` IRI, the decode throws and the caller gets that same 400.

Seen on a Create Now test CN: an outside collaborator's `.from(graphs.allOntologies)` read of
`https://linked.cm/shape/owl/Class` answered 400 once the branch's catalog no longer held the
`@_linked/owl` shapes (a hub holds only the packages it imports, and the spec had seeded the shape
behind the catalog); with the shape in the hub the same read answers 200. It fails closed, so
nothing leaks; it is the message that misleads (it reads as a client bug).

To do:

- Tell an unknown shape from a malformed body: answer the former with its own status and the shape
  IRI (no other detail of the catalog), keep 400 for a body that is not a query.
- Log the decode error at debug level, so a host can see why.
- `src/tests/query-plane-catalog.test.ts` ("a catalog-only shape is an invalid query") changes with it.
