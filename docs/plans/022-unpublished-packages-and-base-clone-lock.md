---
summary: >
  Step SU of CN master plan 057: the app's server treats `linked.unpublishedPackages` (transitively)
  as direct dependencies for boot loading and the ontology/shape sync; the cli locks each shared
  package base clone. Working doc, deleted before landing.
status: Implementation
---

# 022 — Unpublished packages as the app's packages; one lock per base clone (step SU)

Source: CN plan 057 (Rules, K-unpublished, K-kind, K-checkout, Master decisions), CN report 197,
CN backlog 193 §7 (items 1 and 2).

## Decisions

- D1. The server reads the lists with the one reader, `unpublishedPackages(json)` from
  `@_linked/cli/installed-packages` (server already depends on `@_linked/cli` at runtime). A malformed
  list throws (K-unpublished: never skipped).
- D2. A listed package is found the way Node finds it (`node_modules/<name>`, the workspace link
  `npm install` makes into `packages-local/`); before an install, by npm name among
  `<app>/packages-local/*/package.json`. Not found: left out of loading (its name still counts as
  a direct dependency for the reload check, whose reload then fails with "unknown package").
- D3. Lists are followed transitively (each listed package's own list), like localize.
- D4. The cli lock is `<git common dir>/linked.lock` (inside the bare base clone), created with
  `O_EXCL`, holding `{pid, host, at}`; stale when its pid is dead on this host; bounded wait
  (default 120 s), then refusal (exit 6) naming the holder. One lock held at a time (per repo, around
  that repo's git work), so two runs never deadlock. A new base clone is cloned beside its place and
  renamed into it, so the lock always lives in a complete base clone.

## Phases

### Phase 1 — server: the dependency set (done: server suite 510 pass / 2 skip, 12 s; build ok)
- `linkedDependencies.ts`: `unpublishedNames(json)`; `findListedPackage(name, fromDir, appDir)`;
  `discoverLinkedDependencies` roots = `dependencies` + app's list, each visited package also
  follows its list; `readDependencyLists` adds each package's list.
- `LinkedServer`: `reloadablePackages` adds the app's lists transitively; `filterPackagesByDependencyTree`
  follows the lists; adminChannel message names the list.
- Tests (`src/tests/unpublished-packages.test.ts`): app list found via node_modules; via
  packages-local before install; transitive; missing checkout skipped; order after own deps;
  malformed list throws; reloadable set; dependency lists.
- Validation: `npm test` in server (all pass but known pre-existing), `npx linked build`.

### Phase 2 — cli: base clone lock
- `src/integration/repo-lock.ts`: `withRepoLock(commonDir, fn, {timeoutMs, pollMs})`, `commonDirOf`.
- Use in `checkout` (app base + app worktree; each package's base + worktree), new-clone rename,
  `branch fork` (fetch→push), `branch push` (per repo), `branch merge` (fetch per repo; merge step per
  repo), `worktree remove --branch` (per repo).
- Tests: lock acquire/release, wait then acquire, timeout refusal names holder, stale pid taken over,
  reentrant in-process; checkout with a held lock waits/refuses.
- Docs: K-checkout note in cli 002, CN 057, CN 180, CN 200; CLI README/docs if they state it.
- Validation: cli unit suite, `npm run build`.

### Phase 3 — end to end (worktree CN on :4359)
- Fresh user, project, working branch, builder class save → class in the branch dataset's package
  ontology graph (Fuseki query). CN regular set under the slot lock, port 4359.

### Phase 4 — wrap-up
- Changesets (server minor, cli patch), reports server 022 / cli 036, backlog 193 §7 trimmed,
  180 §WU + Progress, 057 table; delete this doc; land; rebuild; remove worktree.

Dependencies: 1 and 2 independent; 3 needs both; 4 last.
