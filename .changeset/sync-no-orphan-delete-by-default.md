---
'@_linked/server': minor
---

Boot-time shape sync no longer deletes store shapes the app did not register.

`LinkedServer` materializes the app's registered shapes into its app-data on every boot. It called
core `syncShapes(appData)` with no options, so on the cores where `orphanScope` defaults to `'all'`
it also deleted every NodeShape in the dataset that the process had not registered. An app whose
backend imports no shapes — the Create Now app template — therefore deleted every NodeShape in its
app-data on boot, including shapes Create Now put there with `bindShape` / `enableCapability`; one
that deep-imported a single shape file deleted the rest of that package.

Boot sync now passes `{orphanScope: 'none'}` explicitly, so it is additive whatever core version the
app resolves. An operator who wants the old pruning can set `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true`
(that exact value; anything else leaves pruning off). Each boot logs one line naming the mode that
ran. The helpers are exported from `@_linked/server/utils/syncShapes`.
