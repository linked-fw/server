---
summary: >
  `GET /admin/routes` tells datasets apart only by store class name, `id` and `default`, because
  the server never sees the storage config's aliases (`appData`, …). A host comparing the storage
  file's routes with the running ones per alias needs the alias: core could record it when
  `loadStores` builds a store, or stores could carry a public name.
packages: [server, core]
---

# 004 — Dataset names in `GET /admin/routes`

Source: CN plan 071, server report 015.

## The gap

`GET /admin/routes` answers one entry per dataset `LinkedStorage` knows (the default dataset
first, then in pin order) with `store` (the class name), `id` when the store has a string `id`, and
`default`. The storage config's aliases are not visible to the server: `loadStores` returns
alias → store to the app's storage file and records nothing, and a storage file may build stores
by hand. Two `FusekiStore`s are told apart only by their position and their routes.

Today that is enough for an app with one routed dataset (the default one, as CN's apps are), and a
host can match a route by its shape IRI in whichever dataset holds it.

## Open questions

1. Should core record the alias when `loadStores` builds a store (a `datasetAlias(store)`
   accessor on the shared global), or should `IDataset` gain an optional public `name`?
2. Should the route then key `datasets` by alias (a breaking change of the body) or add `alias` to
   each entry?

## Also: the routing-pin warning reads a private field

`syncPinWarning` names a store without an `id` by its dataset (`FusekiStore "cn-main"`), and it gets
that name from FusekiStore's private `dataset` field (`datasetName()` in `src/utils/graphTargets.ts`).
The same public store name would replace that read.
