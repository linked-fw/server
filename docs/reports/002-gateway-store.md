---
summary: GatewayStore, an IDataset that forwards Linked Queries to a gateway over HTTP with a
  bearer credential. Records what the store sends, how it maps the gateway's answers to errors,
  and why it has no raw SPARQL, dataset administration or change feed.
---

# GatewayStore

`src/shapes/quadstores/GatewayStore.ts`, exported at
`@_linked/server/shapes/quadstores/GatewayStore`. A backend process selects it from
`linked.backend.datasets.json` when the host that started it (Create Now) wants the process's
queries to go through the host's gateway rather than to a triple store directly: the gateway then
applies its own authorization, audit and copy-on-write branch forks to app traffic.

## What it sends

- `init()`: `GET {endpoint}/health`, `Authorization: Bearer <credential>`. Resolves with the
  gateway's answer (`{projectId, branchName, dataset}`).
- `selectQuery`, `askQuery`, `updateQuery`, `createQuery`, `deleteQuery`: `POST {endpoint}/query`
  with `{v: 1, op, query: query.toJSON()}`, `op` being the `IDataset` method that was called. A
  count query arrives via `selectQuery` and is sent with `op: "select"`; the gateway sees the
  count in the query's own `op`. The body's `result` is returned unchanged.

The store carries no project, branch or actor: the credential identifies the process and the
gateway maps it to a dataset. The query is not re-wrapped; `v` is the wire version this store
speaks, and the gateway's `assertWireVersion` is the check.

## Errors

| Answer | Rejects with |
| --- | --- |
| no HTTP answer (network error) | `GatewayUnreachableError`, `status` 0, `code` `unreachable` |
| `401` | `GatewayUnreachableError`, `code` from the body (`invalid-credential`) |
| any other non-2xx | `GatewayStoreError`, `code` from the body, else `http-<status>`, `body` the parsed answer |
| `2xx` without `result` | `GatewayStoreError`, `code` `bad-response` |

`GatewayUnreachableError extends GatewayStoreError extends Error`. A boot that must fail when the
gateway is down awaits `init()` itself: `LinkedStorage.setDefaultDataset` calls `init()` without
awaiting it.

## What it does not do

No `rawQuery`: the gateway carries DSL-JSON only. No `datasetExists`/ensure: the gateway owns the
dataset. No `subscribeChanges`. No dependency on `Server` or the process's own HTTP server: the
store is a plain `fetch` client, injectable through `config.fetch` for tests.

## Tests

`src/tests/gateway-store.test.ts`: the wire shape of every op with a fake `fetch`, the count path,
`init()`'s route and idempotence, and the error mapping (network, 401, 503 `fork-failed`, 403,
400, non-JSON body, 200 without `result`).
