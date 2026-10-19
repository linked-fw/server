---
summary: In dev, a Vite-owned workspace package's backend is found from `src/` the way linked's
  Vite resolver loads it (`src/backend.tsx`, `src/backend.ts`, or its `exports` target mapped from
  `lib/esm` back to `src`), so an unbuilt workspace's backend is no longer silently skipped.
  2.24.11, patch.
---

# 007 — Dev: load an unbuilt source workspace's backend from `src`

## Problem

In dev, `LinkedServer.indexPackageBackendProviders` found a Vite-owned package's backend only
through its `exports` map (`resolveBackendEntry(dir, json, ['development', 'import', 'node',
'default'])`), which checks that the target file exists. A workspace made by
`linked create-package` exports only `./lib/esm/*`, so an unbuilt one (`src/`, no `lib/`) had no
backend entry: its `src/backend.ts` was never loaded, and the only sign was the optional "Could
not find backend file" warning. Seen with a per-branch app clone whose own asset package was
unbuilt.

## What changed

`src/utils/linkedDependencies.ts`:

- `resolveSourceBackendEntry(dir, json)` mirrors the cli's Vite resolver for `<pkg>/backend`
  (`resolveWorkspaceSpecifier` / `resolveViaWorkspaceExports` in `@_linked/cli`
  `vite-config.ts`). A package whose real root has `src/` is a workspace to that resolver
  (`readSourcePackage`). For it, this tries `src/backend.tsx`, then `src/backend.ts`, then the
  `exports` `./backend` target under `import`/`default` with `./lib/esm/X.js` mapped to
  `src/X.tsx` / `src/X.ts`. A published package has no `src/` and gets `null`.
- `resolveDevBackendEntry(dir, json)`: the source entry, else the existing `exports` resolution
  with `development`.
- `resolveBackendEntry` is refactored without behaviour change: its `exports` walk is
  `resolveBackendExport` with a pluggable file probe, shared by both resolvers.

`src/shapes/LinkedServer.tsx`: the Vite-owned branch (package in `ssr.noExternal`) uses
`resolveDevBackendEntry`. The loader is unchanged (`vite.ssrLoadModule('<pkg>/backend')`).

A built workspace also resolves to `src`, because the Vite resolver maps `<pkg>/backend` to `src`
before it looks at `exports`, so `ssrLoadModule` already evaluates the source. This keeps the
server's notion of the backend file (the path load errors print) the same as Vite's, and stays
right when `lib/` is stale or deleted.

Unchanged: the Node path (production, registry installs left external, the app's own backend)
and published packages.

## Tests

- `src/tests/resolve-backend-entry.test.ts`: unbuilt and built source workspaces resolve to
  `src/backend.ts`; `.tsx` wins over `.ts`; a differently named `lib/esm` export target maps back
  to `src`; a published lib-only package resolves to `lib`; a source package without a source
  backend falls back to `exports`; `src/` without `exports` has nothing to follow.
- `src/tests/boot-installed-providers.test.ts`: in dev, an unbuilt source workspace's
  `src/backend.ts` is loaded through Vite (fails with the old resolution).

## Known limits

- The app's own backend (dev, Vite path) checks only `src/backend.ts`, not `.tsx`. Not tracked.
- The rule "a package with `src/` is a source workspace" now exists in the cli and here; a change
  to the cli's `readSourcePackage` must be mirrored (noted in the `resolveSourceBackendEntry` doc
  comment).

## Follow-ups

None.

## PR

https://github.com/linked-fw/server/pull/175 (2.24.11)
