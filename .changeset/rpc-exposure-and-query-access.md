---
"@_linked/server": minor
---

RPC exposure rules, per-call request context and generic query plane authorization. Requires `@_linked/server-utils` 1.6.

- `/call/...` only dispatches methods the provider's own class owns. `Object.prototype` members, every `BackendProvider`/`ShapeProvider` method (including subclass overrides of lifecycle hooks such as `initRequest`), `constructor`, `__proto__`, accessors and fields always answer 501, also for backend-to-backend calls.
- Methods declared with `@callable('public' | 'user')` (from `@_linked/server-utils/utils/callable`) are dispatched; `'user'` answers 401 without a session. Undeclared methods run and are logged once per method in `warn` mode, and answer 501 in `enforce` mode. Set the mode with the `server.rpcExposure` option or `LINKED_RPC_EXPOSURE`; the default is `warn`.
- A provider class with its own `static rpc = false` is not reachable over the generic `/call/<pkg>/<method>` route.
- Every HTTP call (`/call`, `/api`, page renders) runs in its own call context; backend-to-backend calls outside a request run as system, and lazy provider loading always does. A `{__sc}` Shape-class argument is logged in `warn` and refused (400) in `enforce`.
- The query endpoints (`selectQuery`/`askQuery`/`createQuery`/`updateQuery`/`deleteQuery` and `/api/select|create|update|delete|select-raw`) apply the `QueryAccess` rules: protected shapes answer 403, anonymous queries and raw SPARQL are logged in `warn` and refused in `enforce`, then registered authorizers run.
- `LocalFileStore` refuses keys that resolve outside its base folder.
- `registerCallRoutes(app, linkedServer)` registers the `/call` and `/api` routes.
