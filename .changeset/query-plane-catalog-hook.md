---
"@_linked/server": minor
---

Query-plane shape catalog hook: `setQueryCatalogResolver(resolver)` in `@_linked/server/utils/queryPlane` lets the host supply the `ShapeCatalog` each generic query request (`/call/@_linked/server/*Query`, `/api/*`) is decoded in. The access check and the store lower the query in that catalog. A resolver that throws a `ServerCallError` answers with its status; any other throw answers 500 `Shape catalog unavailable`. Without a resolver, behaviour is unchanged. Requires `@_linked/core` 2.35.0.
