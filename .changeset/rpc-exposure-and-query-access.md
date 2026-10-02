---
"@_linked/server": minor
---

RPC exposure rules, per-call request context and generic query plane authorization. Requires `@_linked/server-utils` `^1.9.0`.

- `/call/...` dispatches provider methods by declaration. Reserved names always answer 501, also for backend-to-backend calls: `Object.prototype` members, every `BackendProvider`/`ShapeProvider` method (including subclass overrides of lifecycle hooks such as `initRequest`), `dispose`, `constructor`, `__proto__`, accessors and fields.
- Methods declared with `@callable('public' | 'user')` (from `@_linked/server-utils/utils/callable`) are dispatched; `'user'` answers 401 without a session. An override that does not redeclare a method keeps the strictest level declared for it up the class chain. Methods no class declares run and are logged once per method in `warn` mode, and answer 501 in `enforce` mode. Set the mode with the `server.rpcExposure` option or `LINKED_RPC_EXPOSURE`; the default is `warn`.
- Methods declared with `@internal()` or `declareInternal(cls, methods)` by the provider's class or a super class answer 501 over HTTP in both modes, even when also declared callable. Backend-to-backend calls still reach them.
- A provider class with its own `static rpc = false` is not reachable over the generic `/call/<pkg>/<method>` route.
- Every request runs in one http call context from the first middleware on (routers, provider middleware and error handlers included); backend-to-backend calls outside a request run as system, and lazy provider loading always does. A `{__sc}` Shape-class argument is logged in `warn` and refused (400) in `enforce`.
- The query endpoints (`selectQuery`/`askQuery`/`createQuery`/`updateQuery`/`deleteQuery` and `/api/select|create|update|delete|select-raw`) apply the `QueryAccess` rules and hand the store the query builder they checked. Before a mutation, one SPARQL `ASK` on the dataset it routes to looks up whether it would write or delete a node typed with a protected class; `setProtectedNodeProbe(fn)` (`utils/queryPlane`) replaces that lookup.
- `/uploads` and resized images are served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
- `LocalFileStore` refuses keys that resolve outside its base folder.
- `registerCallRoutes(app, linkedServer)` registers the `/call` and `/api` routes; `mountUploads(app, folder)` and `enterRequestContext` are exported for the same purpose.
- Client-supplied names in log lines are escaped.

Behaviour changes:

- Generic-plane mutations require a signed-in user in every mode (401), and a create may not choose the ids of its new nodes (403).
- With protected shapes registered, a mutation on a dataset that cannot run SPARQL (`rawQuery`) is refused (403), unless the app sets its own probe.
- `/api/select-raw` is refused (403) in every mode unless the app registers `registerRawQueryAuthorizer`. Its JSON body is also kept as received on `request.rawBody`, which the raw authorizers get as `rawBody` to verify a signature over the exact bytes; with every raw authorizer accepting, the query runs without a session.
- A query body that is not a query answers 400, as does an operation that does not match the query kind (a delete sent to `selectQuery`).
- A query that contains a query-context reference (`{"@ctx": name}`, e.g. built with `.for(getQueryContext('user'))`) answers 400 on the query endpoints. A server-side context map is process-wide and does not identify the caller; send the node id instead.
- `/uploads` files are sandboxed: an HTML file opened from there runs without scripts.
