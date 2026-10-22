---
summary: >
  Before the ontology sync and the shape check, at boot and on `POST /admin/sync-shapes`, every
  linked package the server discovered in the app's dependency tree registers its ontologies
  (core `registerInstalledOntologies`), so a package the app only deep-imports shape files from
  (`@_linked/schema/shapes/Person`) is synced and checked. CN plan 070, §Installed packages'
  ontologies.
---

# 011 — Installed packages register their ontologies at boot

## Why

A package registers its ontology data from its `ontologies/*.register.js` modules, which its index
and `shapes/index` import. The app template imports `@_linked/schema/shapes/Person` directly, so
its boot registered none of schema's data: `ontology sync: written none; skipped none`, and the
shape check reported 69 errors, `Person extends Thing, but … not a subclass` among them (the
app template step's verify log). Registration of installed packages is
explicit, done by the syncer (core report 045).

## What

- `src/utils/ontologySync.ts`: `OntologyCore.registerInstalledOntologies` (optional, like
  `loadOntologyHierarchy`); `loadOntologyCore` imports `@_linked/core/ontology/registerInstalled`
  and leaves it unset when the installed core lacks it. `runOntologyPhase` takes `packageDirs` and
  registers them first, also when the sync is off (the check needs the data too). A failed
  registration is warned about and the sync and check still run; it is not the phase's `failure`
  (the route does not answer 500 for it).
- `src/shapes/LinkedServer.tsx`: the boot (`initOnlyBoot`, `startBoot`) and `resyncShapes` reach
  `runOntologyPhase`, which now passes every directory of `linkedPackageDirs`: each linked package
  discovery found in the app's dependency tree, transitively, at the copy the app resolves.
- Tests: `boot-ontology-sync.test.ts` — the order (register, sync, check), registration with the
  sync off, a failed registration, no registration without directories or with a core that cannot,
  and `loadOntologyCore`'s real core importing a package directory's register module.
- `readme.md` §Ontology sync and the shape check: the registration step.

## Verification

Quick gate after the change, `npm test`:

```
FAIL src/tests/two-copies.test.ts
Test Suites: 1 failed, 28 passed, 29 total
Tests:       409 passed, 409 total
npm test  83.06s user 36.64s system 156% cpu 1:16.41 total
```

Full gate (`npm test && node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build && ls lib/esm/data`),
on `store-inference` 639fb2f (unchanged since the branch was cut):

```
FAIL src/tests/two-copies.test.ts
Test Suites: 1 failed, 28 passed, 29 total
Tests:       409 passed, 409 total
npm test  54.13s user 12.45s system 254% cpu 26.188 total
✔ Build successful
node ~/web/wt/070/packages-local/_linked-cli/lib/esm/launch.js build  8.48s user 0.84s system 196% cpu 4.739 total
server.ttl
```

`two-copies.test.ts` crashes on `main` too (jest module cache, core backlog 060), as in report 010.

**Verify.** A copy of the app template on its integration branch (295cf56), with `npm pack`
tarballs of the integration core (c3a5ef4), cli (a44d30e), schema (57fc01d), fuseki (112f09f)
and this branch's server (4fcafde), one copy of each in `node_modules`; built with
`npm run build -- --allow-dirty` and served with `npm run serve-app` on port 4182 against a
throwaway `linked-fuseki:dev` (compose project `v2-verify`, port 3184, `tdb2` dataset
`v2-verify`).

First boot:

```
[LinkedServer] ontology sync: written @_linked/schema, @_linked/server; skipped @_linked/fuseki, @_linked/primitives, @_linked/server-utils, @_linked/xsd
[LinkedServer] shape check: 0 error(s), 0 warning(s)
[LinkedServer] synced shapes into app-data with orphanScope 'none': 22 shape(s) written, no store shapes deleted (set LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true to prune)
Up and running at http://localhost:4182
```

Second boot:

```
[LinkedServer] ontology sync: written none; skipped @_linked/fuseki, @_linked/primitives, @_linked/schema, @_linked/server, @_linked/server-utils, @_linked/xsd
[LinkedServer] shape check: 0 error(s), 0 warning(s)
[LinkedServer] synced shapes into app-data with orphanScope 'none': 0 shape(s) written, no store shapes deleted (set LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true to prune)
Up and running at http://localhost:4182
```

No `extends-without-subclass` line in either log (`grep -c` 0 and 0). The skipped `fuseki`,
`primitives`, `server-utils` and `xsd` are the npm releases, whose data is still JSON (core's
warning: `ontology data of @_linked/xsd (xsd) is not Turtle text; skipped`); their
registration is new too.

The dataset holds schema's hierarchy (952 `rdfs:subClassOf` triples, among them
`schema:Person rdfs:subClassOf schema:Thing`). With `<urn:v2-verify:alice> a schema:Person`
inserted, `ASK { <urn:v2-verify:alice> a schema:Thing }`:

```
dataset: true
stored: false
```

## Notes for consumers

- CN (C2) syncs cn-main itself with boot shape sync off; it calls core's
  `registerInstalledOntologies` with its own package directories before its `syncOntologies`.
- In dev (`linked start`) the register modules are imported by Node; for a package the SSR runner
  bundles that is a second evaluation, whose registration replaces the runner's (core report 045).
