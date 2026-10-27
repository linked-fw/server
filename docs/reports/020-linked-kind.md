---
date: 2026-10-27
summary: >
  Boot loading decides which installed packages are linked from `linked.kind` (any kind but
  `app`) through `linkedKind(json)`, a byte-identical twin of `@_linked/cli`'s; `linkedPackage`
  is no longer read. `discoverLinkedDependencies` takes an optional test for a linked package.
  The server's own `package.json` says `"kind": "library"`. Step LK of CN master plan 057
  (cli reports 032, 033). Minor.
---

# 020 — Boot loading by `linked.kind`

## PR

### Summary

`src/utils/linkedDependencies.ts` holds `LinkedKind`, `LINKED_KINDS` and `linkedKind(json)`,
byte-identical to `@_linked/cli/installed-packages` between marker comments that name the twin.
`isLinkedPackageJson` is a named package whose kind is set and not `app`.
`discoverLinkedDependencies(appDir, appPackageJson, isLinked = isLinkedPackageJson)` uses the test
it is given for both the walk and the app-copy choice.

### Changes

- `src/utils/linkedDependencies.ts`: the twin, `isLinkedPackageJson` on top of it, the optional
  `isLinked` parameter.
- `src/shapes/LinkedServer.tsx`: a comment.
- Tests: new `src/tests/linked-kind.test.ts` (each kind, absent, non-string, unknown, the old
  flags alone; the walk by kind and with a caller's test); `boot-installed-providers.test.ts`
  adds a package with only `linkedPackage: true` and one with kind `app`, neither loaded; the
  other fixtures write `linked: {kind: 'library'}`.
- `package.json`: `"linked": {"kind": "library", "serverOnly": […]}`; changeset (minor).

### Verification

- `npm test` (`NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs`):
  `Test Suites: 2 skipped, 34 passed, 34 of 36 total` / `Tests: 2 skipped, 499 passed, 501 total`,
  12 s.
- `npx linked build`: `✔ Build successful`, 9 s.

### Deviations

- The optional `isLinked` parameter is new: CN's reader of an app clone's npm-installed packages
  passes a test that also accepts `linkedPackage: true` until the release (CN plan 057 master
  decision). Nothing in the server passes one.

### Follow-ups

- None here. CN drops its `isLinked` argument after the release (CN plan 180 §WU).

## Details

- The twin is checked by eye (marker comments), not by a test; see cli report 032 §Deviations.
- `linkedPackageDirs` keeps its name: it is a field of the server, not the retired flag.
