---
summary: The generic query plane decodes each request's DSL-JSON in a shape catalog the host
  supplies (`setQueryCatalogResolver`), so one server resolves the same shape IRI per request,
  e.g. per project branch. The access check and the store lower in that catalog. Minor; core
  `^2.35.0`.
---

# 004 — Query-plane catalog hook

Consumer: Create Now plan 068 phase 3, which resolves each project branch's shapes against its
own `ShapeCatalog` (core report 037) instead of re-registering them process-wide. CN supplies
the catalog of the admitted (project, branch) and none for its own pinned shapes.

## Problem

`toQueryBuilder` ran `fromJSON(query)` against the global registry, and configuration was
boot-time only: a host could not choose the shapes a request's query resolves against.

## What changed

`src/utils/queryPlane.ts` (export path `@_linked/server/utils/queryPlane`):

```ts
export type QueryCatalogResolver =
  (query: unknown) => ShapeCatalog | undefined | Promise<ShapeCatalog | undefined>;
export function setQueryCatalogResolver(resolver: QueryCatalogResolver | undefined): void;
export function resolveQueryCatalog(query: unknown): Promise<ShapeCatalog | undefined>;
export function toQueryBuilder(query: unknown, catalog?: ShapeCatalog): any; // fromJSON(query, {catalog})
```

- The five `LincdServerBackendProvider` query methods (`src/backend.ts`) and `LincdAPI`'s
  `post_select/create/update/delete` (`src/shapes/LincdAPI.ts`) run
  `toQueryBuilder(json, await resolveQueryCatalog(json))`, then authorize and dispatch as before.
- `resolveQueryCatalog` answers `undefined` without a resolver and for a live builder (it already
  carries its catalog), so the resolver is never called for one. A `ServerCallError` from the
  resolver passes through (`ServerCallError.is`, so another copy of server-utils counts too);
  any other throw is logged and becomes `ServerCallError(500, 'Shape catalog unavailable')`.
- `toQueryBuilder` stays synchronous. It always passes the `catalog` key, so an omitted catalog
  means the global registry even if a scope were active (on the server none is).
- The server opens no scope: `lowerForAccessCheck` and the store's lowering re-enter the
  builder's captured catalog, and `checkQueryAccess` runs outside any scope (a host's own access
  checks read the host's registry).
- `@_linked/core` range `^2.35.0`.

## Verification

```
npx linked build      ✔ Build successful
npm test              Test Suites: 26 passed, 26 total
                      Tests:       365 passed, 365 total
npx jest src/tests/query-plane-hardening.test.ts src/tests/query-plane-catalog.test.ts
                      Test Suites: 2 passed, 2 total
                      Tests:       34 passed, 34 total
```

`src/tests/query-plane-catalog.test.ts` (8 tests, through `registerCallRoutes` on a bare express
app, on both `/call` and `/api`): the resolver is called once per request with the JSON and a
shape known only to its catalog answers 200, with the builder's catalog captured and the dataset
called outside it; a create compiles in the catalog after the store's await; a resolver answering
`undefined` and no resolver keep today's result (global shapes 200, the catalog-only shape 400
`Invalid query`); a live builder passes through without calling the resolver; a plain throw
answers 500 `Shape catalog unavailable` and is logged, a `ServerCallError(404)` answers 404; a
`withAccess` read rule on a catalog-only property refuses (403) and sees the catalog's shape.
With the catalog dropped from `fromJSON`, 3 of the 8 fail.

## Deviations

None from the contract.
