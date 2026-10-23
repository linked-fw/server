---
summary: >
  The control channel reads `APP_ADMIN_SECRET` (`CN_APP_ADMIN_SECRET` as a deprecated fallback)
  and the `x-app-admin-secret` header (`x-cn-admin-secret` as a deprecated fallback), each old
  name logged once per process; without a secret every `/admin/*` route still answers 404. New
  `GET /admin/routes` answers the effective graph routes per dataset (shape IRI → graph IRI) and
  each dataset's default-graph shapes, read through core's public routing accessors. CN plan 071,
  step V3.
packages: [server]
---

# 015 — Admin secret and effective routes

## Plan-mode detail (CN plan 071 §V3 is the sub-plan)

**Contract:** §Graph routing (routes are written only in the app's storage file; CN checks what
runs through `GET /admin/routes`); open question 5, "1b" and "Admin secret rename" (the
open-source server never names CN; `APP_ADMIN_SECRET`, `CN_APP_ADMIN_SECRET` read as a deprecated
fallback).

**Core accessors used (all public, `@_linked/core/utils/*`):** `LinkedStorage.getDatasets()`,
`getDefaultDataset()`, `getDatasetForShapeClass()`; `getShapeGraphs(dataset)` (the registered
table, a copy) and `graphRoutingFor(dataset).graphForShape(iri)` from `graphRouting`;
`getAllShapeClasses()` from `ShapeClass`. No core change was needed.

**Files:** `src/utils/adminChannel.ts` (secret and header names, `resolveAdminSecret`, one-time
deprecation warnings, the route), `src/utils/effectiveRoutes.ts` (new), `src/shapes/LinkedServer.tsx`
(reads the secret through `resolveAdminSecret`), readme §Host control channel. Tests:
`admin-routes` (new); the other admin tests send the new header.

**Phases:** 1. Rename, fallback, route, tests. 2. Full gate, live check on a booted app, changeset,
backlog, this record, landing.

**Pitfalls:** CN sends `x-cn-admin-secret` and sets `CN_APP_ADMIN_SECRET` until C6, so both old
names must keep working. The server never sees the storage config's aliases, so a dataset in the
body cannot be named by its alias (backlog 004). A module that evaluates twice must still warn
once (the warned set lives on the shared global).

## What

- **Secret** (`resolveAdminSecret(env?, warn?)`): `APP_ADMIN_SECRET`, else `CN_APP_ADMIN_SECRET`
  with one warning per process (`[linked] CN_APP_ADMIN_SECRET is deprecated; set
  APP_ADMIN_SECRET instead (read as a fallback for now).`), else `undefined` → every `/admin/*`
  route answers 404, as before. Exported constants `ADMIN_SECRET_ENV`, `LEGACY_ADMIN_SECRET_ENV`,
  `ADMIN_SECRET_HEADER`, `LEGACY_ADMIN_SECRET_HEADER`.
- **Header**: `x-app-admin-secret`, else `x-cn-admin-secret` with one warning per process. The
  header rename is not in §V3's text; it follows the same owner rule (the server must not name CN)
  and keeps the old header working, so CN is unaffected until it switches (C6).
- **`GET /admin/routes`** → 200:

  ```json
  {"datasets": [{"store": "FusekiStore", "id": "…(when the store has one)", "default": true,
    "routes": {"<shape IRI>": "<graph IRI>"}, "defaultGraphShapes": ["<shape IRI>", "…"]}]}
  ```

  One entry per dataset `LinkedStorage` knows, the default first, then in pin order. `routes` is
  the dataset's registered table. `defaultGraphShapes`: every registered shape class that resolves
  to that dataset and whose `graphForShape` is the default graph (no route, no routed super-shape),
  sorted. A sub-shape that inherits a super-shape's route appears in neither list. A thrown read
  answers 500 `{error}`. A handler override `routes` exists for tests and hosts embedding the
  channel.
- Comments and readme in the admin-channel area no longer name CN ("a host"). Elsewhere (ontology
  sync's "a CN clone's packages", `RemoteDataset`'s "CN's gateway", `syncShapesOnBoot`'s "CN sets")
  are examples outside the channel, left as they are.

## Deviations

- The header rename (above), with fallback. Otherwise none from §V3.

## Verification

Worktree `~/web/wt/v3` (`npx linked doctor resolve`: `@_linked/server  v3/packages-local/_linked-server  overlay`;
core and server-utils from the main checkouts, core `200037d`).

Quick gate, phase 1 (`npx jest --config jest.config.cjs src/tests/admin-routes.test.ts src/tests/admin-channel.test.ts`):

```
PASS src/tests/admin-routes.test.ts
PASS src/tests/admin-channel.test.ts
Test Suites: 2 passed, 2 total
Tests:       25 passed, 25 total
Time:        5.943 s
… 8.076 total
```

`npx tsc -p tsconfig-tests.json --noEmit`: clean, 2.1 s.

Full gate:

```
FAIL src/tests/two-copies.test.ts        (Jest module-cache bug, backlog 002 item 4; red on 51f8c9e too)
Test Suites: 1 failed, 2 skipped, 31 passed, 32 of 34 total
Tests:       2 skipped, 460 passed, 462 total
Time:        23.747 s
npm test  78.47s user 18.62s system 383% cpu 25.323 total
✔ Writing shapes.ttl - lib/esm/data/shapes.ttl
✔ Build successful
npx linked build  11.05s user 1.30s system 174% cpu 7.095 total
```

(The 2 skipped suites are the `[fuseki]` live tests, run without `FUSEKI_TEST_PORT`.)

**Verify (master §V3): the route answers with the secret, 404 without; both env names work.**

1. `admin-routes.test.ts`: `effectiveGraphRoutes` over real `LinkedStorage` pins on two stub
   datasets (a route on one, a pin without a route); the route with the secret equals it; 404
   without a secret, 401 for a wrong or missing one; the old header works and warns once;
   `resolveAdminSecret` reads `APP_ADMIN_SECRET` without a warning, prefers it over the old name,
   falls back to `CN_APP_ADMIN_SECRET` with one warning (a later call warns no more); a channel
   opened with either name answers the route.
2. **A booted app.** The worktree's CN (an app on this server) on :4291 against an own Fuseki
   (`ghcr.io/linked-fw/fuseki:6.2.0-2`, container `fuseki-071-v3` on :3192, since :3191 was held by
   another run's `linked-core-test-fuseki-1`; removed afterwards), `FUSEKI_BASE_URL` and
   `FUSEKI_ADMIN_URL` both at it, `FUSEKI_DATASET=cn-wt-v3`:
   - `APP_ADMIN_SECRET=v3-live-secret`: no header → 401; with `x-app-admin-secret` → 200,
     `{"datasets":[{"store":"AppDataRouter","default":true,"routes":{},"defaultGraphShapes":["https://id.create.now/shape/create-now/BridgeShape", …`;
     per dataset `[('AppDataRouter', True, 0, 84), ('FusekiStore', False, 0, 24), ('FusekiStore', False, 0, 7), ('FusekiStore', False, 0, 4), ('Object', False, 0, 1)]`
     (store, default, routes, default-graph shapes). CN's process routes nothing through
     `LinkedStorage` (its per-branch routes live on the branch stores), so `routes` is empty.
   - `CN_APP_ADMIN_SECRET=v3-legacy-secret` only: `x-app-admin-secret 200`, `x-cn-admin-secret 200`
     twice; the log has each warning once:
     ```
     [linked] CN_APP_ADMIN_SECRET is deprecated; set APP_ADMIN_SECRET instead (read as a fallback for now).
     [linked] the x-cn-admin-secret header is deprecated; send x-app-admin-secret instead.
     ```
   - Neither set: `none 404`.

## Landing

(filled at landing)

## Follow-ups

- Backlog [004](../backlog/004-dataset-names-in-admin-routes.md): datasets in the route are told
  apart by class, `id` and `default`; naming them by the storage config's alias needs core.
- C6 (CN plan 071): CN sets `APP_ADMIN_SECRET` for apps and sends `x-app-admin-secret`; then the
  deprecation warnings stop.
- R2: raise `@_linked/core` to the release with `getShapeGraphs` / `graphRoutingFor`.
