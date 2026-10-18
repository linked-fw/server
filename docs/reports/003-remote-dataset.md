---
summary: RemoteDataset replaces BackendAPIStore and GatewayStore (major). One IDataset for
  queries answered by a linked server, the app's own backend (no url) or a remote data server
  (url + token, through fetch), with a public `ping` and typed boot errors.
---

# RemoteDataset

`src/shapes/quadstores/RemoteDataset.ts`, exported at
`@_linked/server/shapes/quadstores/RemoteDataset`. It is `BackendAPIStore` renamed, plus a `url`
form that replaces `GatewayStore` (report [002](002-gateway-store.md)). Both old classes and
their exports are gone; there is no alias.

## Why one class

A host that runs an app (Create Now) wants the app's queries to go through the host's gateway so
that branch forks, authorization and audit apply. `GatewayStore` did that with its own wire
(`POST {endpoint}/query`, `GET {endpoint}/health`) and a mode only the host could switch on. With
the url form, the gateway is an ordinary data server that speaks the server's own `/call` wire,
so an app configured through `linked.backend.datasets.json` and `.env` takes the same path
whoever started it.

## What it sends

- **No `url`:** unchanged from `BackendAPIStore`: `Server.call(packageName, {method,
  rejectOnError: true}, query.toJSON())`, the local shortcut on a backend. `init()` resolves at
  once; `token` is ignored.
- **With `url`:** `POST {url}/call/@_linked/server/<method>` with `{"args": [query.toJSON()]}`,
  `Content-Type` and `Accept` `application/json`, and `Authorization: Bearer <token>` when the
  token is non-empty, through `globalThis.fetch`. `init()` posts `{"args": []}` to `ping`, is
  memoized on success and asks again after a failure. A count goes through `selectQuery`.
- **`url` present but empty:** `init()` and every method throw `RemoteDatasetUnreachableError`
  with `url: ''`. Falling back to the no-url form on a backend would send the app's queries to
  its own provider, whose default dataset is this store: a loop.

The url form never calls `Server` or `LincdServerProxy`: on an app backend the
proxy has a local server, and would answer the app's own provider. It also drops the proxy's
process-wide default headers (the app's own session) and its 502/503/504 retry, which could
apply a write twice.

## Errors

`RemoteDatasetError extends Error` carries `url` (the base), `status` (0 = no HTTP answer) and
`code` (the error body's `code`, when present; the plain `/call` route sends only `{error}`, a
gateway may add a `code`).

| Answer | Rejects with |
| --- | --- |
| no HTTP answer, or an empty `url` | `RemoteDatasetUnreachableError` |
| 401 or 403 | `RemoteDatasetUnauthorizedError` |
| on `ping` only: 404, 501, 502, 503, 504, or a body that is not JSON | `RemoteDatasetUnreachableError` |
| any other non-2xx | `RemoteDatasetError` |

A 200 whose body is `null` resolves `null`: a method that returned `undefined`. Messages name the
url and the method, never the token.

## `ping`

`@callable('public') async ping(): Promise<{ ok: true }>` on `LincdServerBackendProvider`,
behind `POST /call/@_linked/server/ping`. It reads nothing and changes nothing. A plain linked
server has no token concept, so it always answers `{ok: true}`; a host that checks tokens answers
401 for a refused one.

## What stays

The ontology term `server:BackendAPIStore` (`src/ontologies/server.ts`) is an IRI; renaming it
would change data, and nothing routes on it since the store stopped being a Shape.

## Tests

`src/tests/remote-dataset.test.ts` (stubbed `globalThis.fetch`): the wire of every method with
and without a token, the count path, that the url form never reaches `Server` or its local
server, no retry, `init()`'s ping, memo and retry after failure, the error mapping (network,
404/501/502/503/504 and non-JSON on ping, 401/403, 503 `fork-failed` on a query, empty url), no
token in any message, and `ping` through `registerCallRoutes` on a bare express app.
`remote-dataset-ask.test.ts`, `call-errors.test.ts` and `call-semantics.test.ts` cover the no-url
form, unchanged.
