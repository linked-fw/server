---
summary: >
  Follow-ups of graph queries through the server: core's graph-registry cache is module state, so
  with two copies of core in one process `POST /admin/graph-registry-changed` drops only one
  copy's entries; the route drops every entry because no store tells its cache key; the
  `/api/*` plane has no graph arm; review lows of report 013.
packages: [server, core]
---

# 002 — Graph registry cache: copies of core and targeted invalidation

Source: CN plan 071, server report 013.

## 1. Two copies of core keep two caches

`@_linked/core/utils/graphRegistryCache` keeps its entries in module-level maps, not in
`sharedState` on `globalThis` as the query dispatch and the shape registry do. When core is
evaluated twice in one process (dev: Vite's SSR graph and the server's node import), a store
from one copy caches in that copy, and the control channel's route (server, node import) drops
the other copy's entries. The 30-second expiry still bounds the staleness.

First questions: move the maps into `sharedState('@_linked/core', 'graphRegistry', …)` (core);
does any test rely on per-copy state?

## 2. The route drops every entry

`POST /admin/graph-registry-changed {dataset}` calls `invalidateGraphRegistry()` with no key:
a store's key is its protected `graphRegistryKey()` (`FusekiStore`: `{baseUrl}/{dataset}`,
`RemoteDataset`: the dataset its server names in `ping`), no store exposes it or its dataset
name, and the stores are built by the app's storage config, whose aliases the server does not
see. The cost is one registry read per cached dataset on its next expanding read.

First questions: a public `graphRegistryKeyFor(name)` or `matchesDataset(name)` on stores (core
`IDataset`, optional), so the route can drop only that dataset's entry? Worth it only if apps
cache many datasets.

## 3. No graph arm on `/api/*`

`LincdAPI`'s `post_select`/`post_create`/… have no graph counterpart; `RemoteDataset` uses
`/call/@_linked/server/graphQuery`. Add one only if a client of `/api/*` needs it.

## 4. `two-copies.test.ts` hits Jest's module-cache bug

On the integration core, three of its six tests stop the worker with "Module cache already has
entry …/lib/esm/utils/linkedError.js. This is a bug in Jest" (`jest.isolateModulesAsync` of
modules that import core). Reproduced on this repository's `main` source (364d12f, with a stub
`graphQuery` so it compiles), so it is not caused by the graph work; core has the same failure
in `two-copies-built.test.ts` (core backlog 060). Fix with core's.

## 5. Review lows of report 013

- **Whose identity reads the registry.** A url-form `RemoteDataset` reads the registry records
  under whichever end user's request triggers the load (`forwardEndUser`) and caches the result
  for every user of the process. Records name graphs and packages, not data; whether the read
  should run as the service (no end user) is a design choice. A refused read leaves the names
  unexpanded, so nothing breaks.
- **Fork staleness of the key.** `RemoteDataset` memoizes its `ping`, so after CN forks a branch
  the key still names main's dataset. Harmless while the route drops every entry (item 2).
- **Bad record fields answer 500.** `parseGraphQuery` does not check `record` fields or the
  record class; core's record builder (`graphRecords.ts`) throws a plain `Error`, so the plane
  answers 500, not 400. Needs core to brand those errors (`GraphQueryError` with a new code) or
  to check them in `parseGraphQuery`.
- **No-url form over HTTP loses the code.** server-utils' `Server.call` builds its
  `ServerCallError` from `{error}` only, so a browser's `RemoteDataset` sees a graph refusal as
  its status (501 still maps to `unsupported-query-kind`). Unreachable today: graph statics are
  server-only.
- **Observation by target only.** The ontology phase counts every graph query on the synced
  dataset while the sync runs, so a concurrent caller's graph write on the default dataset would
  be reported as the sync's.
