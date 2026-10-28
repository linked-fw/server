---
date: 2026-10-28
summary: >
  The packages an app lists in `linked.unpublishedPackages` (and, transitively, the lists of those
  packages) are its direct dependencies: boot loading finds them by npm name, the shape sync's
  reload check accepts them, the shape check reads each list as dependencies. A class saved on a
  project branch now reaches the branch dataset. Minor. Step SU of CN master plan 057 (with cli
  report 036).
---

# 022 — Unpublished packages are the app's direct dependencies

## PR

### Summary

An app's own ontology and asset packages are no longer in its `dependencies`: they are listed in
`linked.unpublishedPackages` (K-unpublished) and localized into `packages-local/`. The server read
only `dependencies`, so a branch app never loaded them at boot and refused the host's re-sync
(`unknown package: {slug}-ont is neither the app nor one of its direct dependencies`, CN report
197): a class saved in the builder never reached the branch dataset. Now every listed package,
transitively through each package's own list, counts as a direct dependency of whoever lists it.

### Changes

- `src/utils/linkedDependencies.ts`:
  - `unpublishedNames(json)`: the names of a `package.json`'s list, read with the one reader,
    `unpublishedPackages` from `@_linked/cli/installed-packages` (the server already depends on the
    cli at runtime), so a malformed list throws.
  - `findListedPackage(name, fromDir, appDir)`: a listed package by npm name, first the way Node
    finds it (npm's workspace link into `packages-local/`), else among
    `<app>/packages-local/*/package.json` by `name` (a checkout not yet installed); null when there
    is no checkout.
  - `listedPackageNames(appDir, json)`: the app's list, transitively.
  - `discoverLinkedDependencies` starts from `dependencies` and the app's list, and follows each
    visited package's list as well as its `dependencies` (still dependencies first, by realpath).
  - `readDependencyLists` adds each package's list (the shape check's direction-I scope).
- `src/shapes/LinkedServer.tsx`: `reloadablePackages` adds `listedPackageNames` (read from disk per
  call, so a list written after the boot counts); `filterPackagesByDependencyTree` (workspace
  members loaded whole) follows the lists of the app and of each package reached.
- `src/utils/adminChannel.ts`: the refusal names where direct dependencies come from
  (`dependencies, devDependencies, linked.unpublishedPackages`).
- `linkedKind` usage and its twin are unchanged.
- Tests `src/tests/unpublished-packages.test.ts` (9): the reader and its errors, discovery through
  the workspace link, through `packages-local/` before an install, transitively and in order, after
  shared published dependencies, a listed package without a checkout (not loaded, still reloadable),
  one without `linked.kind` (not loaded), the dependency lists.
- Changeset `.changeset/unpublished-packages.md` (minor).

### Verification

- Server suite (`npm test`, 12 s):
  ```
  Test Suites: 2 skipped, 35 passed, 35 of 37 total
  Tests:       2 skipped, 510 passed, 512 total
  ```
- `npx linked build`: `✔ Build successful` (7.6 s).
- **End to end** on the worktree CN (`PORT=4359`, own dataset `cn-wt-su`, own projects root,
  `WEBID_MODE=bypass`, `CN_APP_TEMPLATE_BRANCH=main`, real GitHub in `linked-cm-testing`), fresh
  user `su-step@test.local`: Add Project "Su Bricks" (app and two package repos created, checkout on
  `change-1`). The branch app's own `npm install` has `@_linked/server` 3.12.1 from npm, which reads
  neither `linked.kind` nor the lists, so its `node_modules/@_linked/*` were pointed at the dev
  checkouts (this worktree's server and cli, the main checkout's others) and the app restarted. Then
  Model Manager → Create Ontology "Bricks", class `Brick`, Save 0.0.1 on `change-1`:
  ```
  [packageBranches] forked change-1 in su-bricks-ont for …/su-step-su-bricks-su-bricks/change-1
  [branch-fork] forked "su-step_hub" into "su-step_su-bricks_change-1_hub" (1530 quads)
  su-step_su-bricks_change-1_hub, graph https://su-step.id.create.now/pkg/su-bricks-ont/graph/ontology:
    su-bricks:Brick rdf:type owl:Class ; rdfs:label "Brick"
  su-step_hub (main's data): no su-bricks-ont ontology graph
  ```
  **The class reached the branch dataset's package ontology graph.** The save forked the branch
  dataset, which restarts the app, so the boot's ontology sync may have written it; the host's
  re-sync route was checked on its own against the running app: a second class `Plate` added to the
  package's `.ttl`, then `POST /admin/sync-shapes`:
  ```
  {"packages":["other-ont"]}    400 {"error":"unknown package: other-ont is neither the app nor one of its direct dependencies (dependencies, devDependencies, linked.unpublishedPackages)"}
  {"packages":["su-bricks-ont"]} 200 {"written":0,…,"ontologies":{"written":["su-bricks-ont"],…,"graphs":["https://su-step.id.create.now/pkg/su-bricks-ont/graph/ontology"]},"shapeCheck":{"errors":0,"warnings":0},"reloaded":["su-bricks-ont"],…}
  branch graph classes: su-bricks:Plate, su-bricks:Brick
  ```
  Afterwards the three repos were deleted (`existed true now false`; no `su-step`/`su-check` repo
  left in the org) and the six `cn-wt-su` / `su-step_*` datasets dropped (`200`).
- CN regular set: see cli report 036 §Verification (one run for the step).

### Deviations

- The end-to-end check needed the branch app's framework pointed at the dev checkouts by hand
  (above): until the release a branch app runs npm's `@_linked/*`. Recorded in CN backlog 193 §7.
- **An incident during the check**: the first browser sign-in ran against the owner's CN on
  `:4040`, because `.env`'s `SITE_ROOT=http://localhost:4040` is what the bundle calls and only
  `PORT` was overridden. The owner's CN created a user `su-check@test.local` (account
  `useraccount_01M602C3K2RJQFRA2JXTJ3D636`, person `http://localhost:4050/id/c724d7554b539a41d39587f552c59512#me`),
  workspace `su-check` with its roles and membership, two dataset records and their Fuseki datasets
  `su-check_cn` and `su-check_hub`, and three activity events in `cn-main`; its `createProject`
  answered 500 and left no repo. Nothing of the owner's own records changed. These were left for the
  owner to remove (removing records from `cn-main` is not a step agent's call). The check was then
  rerun with `SITE_ROOT` set; the pitfall is CN backlog 193 §7.
- The ontology editor's Save on an existing ontology (`/edit`, second class) fails on the branch
  with `Writes on the query plane need an active project` and writes no `.ttl` (CN UI, not this
  change); hence the `.ttl` edit by hand for the re-sync check. CN backlog 193 §7.

### Follow-ups

- At the release, `@_linked/server`'s `@_linked/cli` range must reach the cli release whose
  `installed-packages` exports `unpublishedPackages` (npm's 1.57.5 does not) — CN sub-plan 180 §WU.
- Branch apps on the npm framework until the release; a worktree CN's `SITE_ROOT`; the editor's
  edit-page save — CN backlog 193 §7.
- Stray `su-check` records in the owner's `cn-main` and datasets `su-check_cn` / `su-check_hub`:
  for the owner (listed above).

## Details

- A listed package is found through `node_modules` first because that is the copy Node and Vite
  load; the `packages-local/` scan by `name` covers a checkout made before `npm install` (directory
  names come from `checkoutNameFor`, so the scan matches the npm name, not the directory).
- A listed package without a checkout stays reloadable by name, so the host gets "unknown package"
  only for names nothing lists; its reload then fails as before with `unknown package: <name>` from
  `reloadPackageFromDisk`.
- Lists are read on each `reloadablePackages` call: CN's repair writes a list onto a working branch
  after the app booted, and the next save must not be refused for it.
