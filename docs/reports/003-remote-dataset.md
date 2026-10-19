---
summary: RemoteDataset replaces BackendAPIStore and GatewayStore (3.0.0). One IDataset for
  queries answered by a linked server, the app's own backend (no url) or a remote data server
  (url + token, through fetch), with a public `ping` and typed boot errors. `init()` keeps the
  ping body as `info` (3.2.0); the url form sends the signed-in user's WebID as
  `x-linked-end-user` (3.4.0), read without importing node:async_hooks so the store still loads
  in the browser (3.4.1).
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
- **End user (url form only):** when the current call context is `http` and its request has a
  signed-in user (`request.linkedAuth.userAccount.accountOf.id`), every post carries
  `x-linked-end-user: <WebID>` (`END_USER_HEADER`, helper `currentEndUserWebId()`). A system
  context (`runAsSystem`), an anonymous request and code outside any call send none.
  `forwardEndUser: false` (or the string `"false"` from an interpolated config) turns it off. The
  token still decides which data the store reaches; the header only says whom the query is for,
  e.g. for the host gateway's audit. On by default, so a store pointed at a third-party server
  sends it the WebIDs of signed-in users; the README warns about this under *With `url`*.
- **`url` present but empty:** `init()` and every method throw `RemoteDatasetUnreachableError`
  with `url: ''`. Falling back to the no-url form on a backend would send the app's queries to
  its own provider, whose default dataset is this store: a loop.

The url form never calls `Server` or `LincdServerProxy`: on an app backend the
proxy has a local server, and would answer the app's own provider. It also drops the proxy's
process-wide default headers (the app's own session) and its 502/503/504 retry, which could
apply a write twice.

## `info`

`init()` resolves the data server's `ping` body, frozen (`{}` when the body is not a JSON
object), and the store keeps it as the readonly getter `info` (`RemoteDatasetPingInfo =
Readonly<Record<string, unknown>>`). The no-url form resolves `undefined` and `info` stays
`undefined`. Memoization and retry-after-failure are unchanged. A gateway that names the dataset
it serves lets the app log it at startup:

```ts
const store = new RemoteDataset({url: process.env.DATA_URL, token: process.env.DATA_TOKEN});
await store.init();
console.log('data goes to', store.info?.dataset); // e.g. {ok, projectId, branchName, dataset, forked}
```

## Browser safety

The no-url form also runs in the browser, so the module must not import anything Node-only.
`RemoteDataset` reads the call context from the store `@_linked/server-utils/utils/CallContext`
shares on `globalThis` (`Symbol.for('@_linked/server-utils:callContext')`) and imports that
module for its type only. Importing it at runtime (3.4.0) pulled in `node:async_hooks` and broke
hydration of every frontend that loads the store (Create Now's sign-in page stuck on "Loading
saved profiles"); 3.4.1 fixed it. In a browser the key is unset, so no header is sent. The error
classes are branded (`brandLinkedError`, report [005](005-shared-state-across-copies.md)).

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
It also covers `info` (the ping body kept, `{}` for a non-object body, `undefined` without url),
the end-user header (sent for a signed-in http context; none for system, anonymous or no context;
`forwardEndUser: false`), and pins that the module has no runtime import of `CallContext`,
`async_hooks` or a `node:`/`fs`/`path` module. `remote-dataset-ask.test.ts`, `call-errors.test.ts`
and `call-semantics.test.ts` cover the no-url form, unchanged.

## Releases

| Version | Change |
| --- | --- |
| 3.0.0 | `RemoteDataset` replaces `BackendAPIStore` and `GatewayStore`; `ping` |
| 3.2.0 | `init()` resolves the ping body; `info`, `RemoteDatasetPingInfo` |
| 3.4.0 | `x-linked-end-user`, `END_USER_HEADER`, `currentEndUserWebId`, `forwardEndUser` |
| 3.4.1 | no runtime import of `CallContext` / `node:async_hooks` |

## Follow-ups

- Create Now's gateway reads `x-linked-end-user` and adds `forked` to its ping body: Create Now
  backlog 117 (CN repo).
- None open in this repo.

## PRs

- https://github.com/linked-fw/server/pull/179 (3.0.0)
- https://github.com/linked-fw/server/pull/185 (3.2.0)
- https://github.com/linked-fw/server/pull/190 (3.4.0)
- https://github.com/linked-fw/server/pull/192 (3.4.1)
- https://github.com/linked-fw/server/pull/196 (README warning on `forwardEndUser`)
