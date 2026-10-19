---
summary: How the server applies `@callable` levels from @_linked/server-utils. Since 3.5.0 it
  enforces and reports `'signed-in'` (401 without a session) and treats the deprecated `'user'`
  exactly like it. The README documents `server.rpcExposure` (`warn` / `enforce`,
  `LINKED_RPC_EXPOSURE`) and links to server-utils for the declarations.
---

# 006 — Callable levels (`'signed-in'`) and `server.rpcExposure`

## Why

`@_linked/server-utils` 1.14.0 renamed the session-requiring callable level from `'user'` to
`'signed-in'`, because `'user'` read like "any user, including anonymous". `'user'` stays as a
deprecated alias so existing declarations keep working. The server is where levels are enforced
(`/call/...` dispatch), so it has to accept both spellings and report one.

## What changed

`src/utils/rpcExposure.ts` (3.5.0):

- Declared levels are read through a local `getOwnCallableLevel` that maps `'user'` to
  `'signed-in'`. The module's exported `CallableLevel` is `'public' | 'signed-in'`, so
  `resolveCallable` reports `'signed-in'` for both spellings.
- The strictness order is `{public: 0, 'signed-in': 1}`: an override of an inherited method keeps
  the strictest level declared up the chain, and `'user'` ranks as `'signed-in'`.
- The undeclared-RPC warning suggests `@callable('public' | 'signed-in')`.

`src/shapes/LinkedServer.tsx`: `assertSessionForLevel` answers 401 for a `'signed-in'` method
called without a session (covers `'user'` too).

`@_linked/server-utils` range `^1.14.0`.

```ts
import {callable} from '@_linked/server-utils/utils/callable';

class NotesProvider extends BackendProvider {
  @callable('public') async listPublic() { /* ... */ }
  @callable('signed-in') async myNotes() { /* 401 without a session */ }
}
```

## README

The README section *Which methods a client may call (`server.rpcExposure`)* (#189) documents the
mode: `'warn'` (default) runs an undeclared method and logs it once, `'enforce'` answers 501;
without the config key, `LINKED_RPC_EXPOSURE` sets it. It links to server-utils' README section
*Which provider methods a client may call* for the declarations, so both packages point at one
place. Since 3.3.0 the mode is shared across copies of this package (report
[005](005-shared-state-across-copies.md)).

## Tests

`src/tests/rpc-exposure.test.ts`: the 401 case runs for both a `'signed-in'` and a `'user'`
method; `'user'` resolves as `'signed-in'` and ranks the same when an undeclared override
inherits it. `src/tests/query-plane-hardening.test.ts` updated to the reported level.

## Follow-ups

Consumers move their declarations from `'user'` to `'signed-in'` (auth, schema, translation,
webid-email, Create Now): tracked in those repos, none here.

## PRs

- https://github.com/linked-fw/server/pull/193 (3.5.0)
- https://github.com/linked-fw/server/pull/189 (README, no release)
