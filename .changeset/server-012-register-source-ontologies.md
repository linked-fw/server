---
'@_linked/server': minor
---

The ontology registration before the sync and the shape check also covers the app's own workspace
packages (`linkedPackage: true` under its `workspaces`), which the dependency walk misses when no
package imports them (a Create Now clone's `packages/<slug>-ont`). In dev, a package without a
built `lib/` registers from `src/ontologies/*.register.ts` through Vite's `ssrLoadModule` (core
`registerInstalledOntologies`' `importModule`); a built app skips it.
