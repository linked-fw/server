---
'@_linked/server': minor
---

The generic query endpoints (`/call/@_linked/server/*Query` and `LincdAPI` `/api/*`) now apply the per-store access rules of `@_linked/server-utils` 1.11 (`withAccess`), declared on the stores in the app's `linked.backend.storage.js`. A store without a rule requires a session.

**This access model is interim. It needs to be revised and rethought from the ground up.**

- Removed from `utils/queryPlane`: `setProtectedNodeProbe`, `askProtectedNodes` and `protectedNodeAsk`. The server no longer runs an `ASK` against the store before a mutation.
- Kept: `@ctx` references are refused (400), the query that was checked is the builder the store runs, an operation must match its query's kind, a mutation may not choose the ids of new nodes, and `server.rawQueries` decides raw SPARQL.
- Queries providers run themselves are not checked.
- Requires `@_linked/server-utils` ^1.11.0.
