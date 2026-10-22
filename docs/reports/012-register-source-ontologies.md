---
summary: >
  The ontology registration before the sync and the shape check also covers the app's own
  workspace packages, and in dev an unbuilt one registers from `src/ontologies/*.register.ts`
  through Vite's `ssrLoadModule` (core `registerInstalledOntologies`' `importModule`), so a Create
  Now clone's `packages/<slug>-ont` is synced in dev. CN plan 070, §Installed packages' ontologies.
---

# 012 — Workspace packages register their ontologies, unbuilt ones through Vite

## Why

A Create Now clone's ontology package `packages/<slug>-ont` has no `lib/` in dev, and nothing the
app loads imports it, so the boot and `POST /admin/sync-shapes` never registered it: the
ontology builder's writes could not reach the store (CN report 109, §Blocked). Two gaps: the
dependency walk does not reach a workspace package no one depends on, and the registration
(report 011) imported only built register modules.

## What

- `src/utils/ontologySync.ts`: `runOntologyPhase` takes `importModule` and passes it to core's
  `registerInstalledOntologies(packageDirs, {importModule})` (one argument without it).
  `ontologyPackageDirs(linked, workspace)`: the discovered linked package directories, then the
  app's workspace package directories, duplicates dropped. `sourceModuleImporter(vite)`: Vite's
  `ssrLoadModule` when there is a Vite dev server, else undefined.
- `src/shapes/LinkedServer.tsx`: `initBackendProviders` keeps the app's workspace packages
  (`getLincdPackages()`: `linkedPackage: true` under `workspaces`, by real path) in
  `workspacePackageDirs`; `runOntologyPhase` passes both lists and, in dev, the Vite loader. A
  built app registers a built workspace package from its `lib/` and skips an unbuilt one.
- Tests (`boot-ontology-sync.test.ts`, +4): `importModule` reaches the registration (and is
  absent without it); the directory list; the loader is `ssrLoadModule` bound to Vite, absent
  without Vite; the real core imports a source package's register module only through the loader.
- `readme.md` §Ontology sync and the shape check: the workspace packages and the dev loader.

## Verification

Gate (`npm test`), rebased on `store-inference` 10f501e:

```
FAIL src/tests/two-copies.test.ts
Test Suites: 1 failed, 28 passed, 29 total
Tests:       413 passed, 413 total
npm test  67.92s user 15.75s system 375% cpu 22.257 total
```

`two-copies.test.ts` crashes on `main` too (jest module cache, core backlog 060), as in reports
010 and 011. The build runs in the integration worktree after landing (in the step's layout,
`LincdWebApp.ts` fails to type-check with or without this change: `@_linked/server-utils` comes
through `~/web/wt/070` with its own core, so `Shape` is declared twice).

**Verify.** A copy of the app template (`~/web/wt/070-T1/app-template`) with `workspaces:
["packages/*"]` and `packages/v3check-ont` (`linkedPackage: true`; `src/ontologies/v3check.ts`,
`v3check.register.ts`, `src/data/v3check.ttl` with `v3check:Dog rdfs:subClassOf v3check:Animal`;
no `lib/`, imported by nothing), its `node_modules` linked to the step's resolution overlay (this
branch's server and core), booted with `linked start` on port 4189 against a throwaway
`linked-fuseki:dev` (compose project `v3-verify`, port 3190, `FUSEKI_BASE_URL` and
`FUSEKI_ADMIN_URL` both on it).

First boot:

```
[LinkedServer] ontology sync: written @_linked/schema, @_linked/server, @_linked/xsd, v3check-ont; skipped @_linked/fuseki, @_linked/primitives, @_linked/server-utils
[LinkedServer] shape check: 0 error(s), 0 warning(s)
Up and running at http://localhost:4189
```

`ASK { v3check:Dog rdfs:subClassOf v3check:Animal }` on the dataset: `"boolean" : true`.

Second boot:

```
[LinkedServer] ontology sync: written none; skipped @_linked/fuseki, @_linked/primitives, @_linked/schema, @_linked/server, @_linked/server-utils, @_linked/xsd, v3check-ont
```

## Notes for consumers

- CN (C3): a clone's `packages/<slug>-ont` now registers at boot and on each re-sync in dev; its
  `loadData` re-reads the Turtle on every sync, so the builder's write reaches the store on the
  next `POST /admin/sync-shapes`.
- Workspace packages are registered in a built app too (from their `lib/`), also when nothing
  imports them.
