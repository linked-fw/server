---
"@_linked/server": major
---

`BackendAPIStore` is renamed `RemoteDataset` and gains a `url`/`token` form for a remote data server; `GatewayStore` is removed; new public `ping` method.

Migration:

- **`BackendAPIStore` users:** replace the import path `@_linked/server/shapes/quadstores/BackendAPIStore` with `@_linked/server/shapes/quadstores/RemoteDataset` and the class name `BackendAPIStore` with `RemoteDataset` (in code and in the `store` of `linked.{frontend,backend}.datasets.json`). Without `url` the behaviour is unchanged; there is no alias.
- **`GatewayStore` users:** point `RemoteDataset` at the server's `/call` base instead: config `{ "url": "<base>", "token": "<bearer token>" }` (was `{ endpoint, credential }`). It posts `{"args": [query.toJSON()]}` to `{url}/call/@_linked/server/<method>` with `Authorization: Bearer <token>`; the `{v, op, query}` envelope, `/query` and `/health` routes and the `fetch` config override are gone.
- **Config:** `RemoteDatasetConfig` is `{ url?, token?, name?, id? }`. A `url` that is present but empty never falls back to the no-url form.
- **`init()`:** with `url`, it posts to `{url}/call/@_linked/server/ping` (memoized on success) and throws a typed error. Await it before registering the store.
- **Errors:** `GatewayStoreError` / `GatewayUnreachableError` are replaced by `RemoteDatasetError` (`url`, `status`, optional `code`) and its subclasses `RemoteDatasetUnreachableError` (no answer, empty url, or nothing at the url speaks the wire) and `RemoteDatasetUnauthorizedError` (401 or 403).
- **`ping`:** `POST /call/@_linked/server/ping` is a new `public` method that answers `{ "ok": true }`.
