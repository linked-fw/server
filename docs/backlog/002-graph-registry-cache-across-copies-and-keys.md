---
summary: >
  Follow-ups of graph queries through the server: core's graph-registry cache is module state, so
  with two copies of core in one process `POST /admin/graph-registry-changed` drops only one
  copy's entries; the route drops every entry because no store tells its cache key; the
  `/api/*` plane has no graph arm.
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
