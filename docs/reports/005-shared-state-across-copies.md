---
summary: A second copy of @_linked/server in one process (Vite's SSR runner next to Node under
  `linked start`) shares the server's configuration and recognises its errors. `rawQueries`,
  `rpcExposure` and the query catalog resolver live on globalThis via core `sharedState`; the
  process setup runs once per process; RemoteDataset errors and FatalStartupError are branded.
  3.3.0, core `^2.36.0`.
---

# 005 — Shared state across copies, process setup once, branded errors

## Why

Under `linked start` in dev, the same package can be evaluated twice in one process: once by
Node and once by Vite's SSR runner. Each copy had its own module-level state. `LinkedServer`
wrote the configuration on one copy, and the query plane or the RPC dispatcher read it on
whichever copy they loaded, so the other copy fell back to its defaults, two of which are the
permissive ones:

| Setting | Module | What a second copy read |
| --- | --- | --- |
| `server.rawQueries` | `src/utils/rawQueries.ts` | `'session'`, even when config said `'off'` |
| `server.rpcExposure` | `src/utils/rpcExposure.ts` | `'warn'`, even when config said `'enforce'` |
| `setQueryCatalogResolver` | `src/utils/queryPlane.ts` | no resolver: every query decoded in the global registry |

A second copy also re-ran `LinkedServer.tsx`'s module-level setup: it wrapped the already wrapped
`fetch` in a second cookie jar and registered every `process` listener twice (double logging).
And `instanceof RemoteDatasetUnreachableError` failed for an error thrown by the other copy.

This applies linked-fw/cli backlog 017; the convention is in the cli repo's
`docs/architecture/shared-state-and-error-brands.md`. The backlog named only the error classes
for this package; the survey for it found the three settings and the process setup as well.

## What changed (3.3.0)

- The three settings are stored with `sharedState('@_linked/server', '<name>', init)` from
  `@_linked/core/utils/sharedState` (keys `rawQueries`, `rpcExposure`, `queryPlane`). Their
  setter and getter APIs are unchanged.
- `LinkedServer.tsx` runs `installProcessSetup()` (cookie-jar `fetch`, `uncaughtException` /
  `unhandledRejection` / `warning` listeners, `setMaxListeners`) only when the shared
  `LinkedServer.processSetup` state is not yet `done`.
- `RemoteDatasetError`, `RemoteDatasetUnreachableError`, `RemoteDatasetUnauthorizedError`
  (`src/shapes/quadstores/RemoteDataset.ts`) and `FatalStartupError` (`src/utils/fatalError.ts`)
  are registered with `brandLinkedError(Class, '@_linked/server', '<Name>')`.
- `@_linked/core` range `^2.36.0`. README section on the behaviour.

Usage, from code that may hold an error from either copy:

```ts
import {isLinkedError} from '@_linked/core/utils/linkedError';
import {RemoteDatasetUnreachableError} from '@_linked/server/shapes/quadstores/RemoteDataset';

if (isLinkedError(err, RemoteDatasetUnreachableError)) { /* data server down */ }
```

`isLinkedError` against the base `RemoteDatasetError` also matches its subclasses.

## Tests

`src/tests/two-copies.test.ts` loads a second, independently evaluated copy of each module and
everything it imports, core included (`jest.isolateModulesAsync`). It shows that a mode or
resolver set through one copy is read through the other; that an error from the other copy fails
`instanceof` and matches `isLinkedError` (subclass against base too); and that importing a second
copy of `LinkedServer` leaves `globalThis.fetch` and the `uncaughtException` listener count
unchanged (6 tests). With the `rawQueries` state made module-local again and the once-guard
removed, 2 of the 6 fail.

## Known limits

`instanceof ShapeProvider` / `BackendProvider` checks in `LinkedServer.tsx` are not shared; they
already fall back to a name check. `instanceof` on core classes across copies is core's backlog 057.

## Follow-ups

Core-class `instanceof` across copies: linked-fw/core `docs/backlog/057`. None in this repo.

## PR

https://github.com/linked-fw/server/pull/187 (3.3.0)
