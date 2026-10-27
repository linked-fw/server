---
summary: >
  RemoteDataset's url form sends the signed-in user's own Solid-OIDC access token
  (`x-linked-user-token`) with a fresh DPoP proof per request, from @_linked/auth's headers hook,
  instead of the unsigned `x-linked-end-user` WebID; `forwardUserToken` replaces
  `forwardEndUser`. Create Now plan 080 step R2b. Minor (small breaking change).
packages: [server]
---

# 019 — The user's own token to the data server

Create Now plan 080 step R2b (CN report 151, `docs/reports/151-user-token-at-the-gateway.md` in
the Create Now repo), with `@_linked/auth` report 021 and webid.email report 023. Landed on the
integration branch `dev` together with them.

## PR

### Summary

A query an app's `RemoteDataset` (url form) makes while answering a signed-in user's request now
carries that user's own access token and a DPoP proof for that one request, so a data server
(CN's gateway) can verify who the user is instead of trusting a WebID the app names.

### Changes

- `src/shapes/quadstores/RemoteDataset.ts`: for an http call context, `post` asks the hook on
  `globalThis[Symbol.for('@_linked/auth:userTokenHeaders')]` (exported as
  `USER_TOKEN_HEADERS_HOOK`) with the request and `{method: 'POST', url}` (the exact URL posted
  to) and sends `x-linked-user-token` (`USER_TOKEN_HEADER`) and `DPoP` beside the bearer. Asked per
  request, never cached. A hook that throws or answers anything but two non-empty strings sends
  neither and warns once per process; the query still goes. A system context, an anonymous
  request, code outside any call and a process without the hook send neither.
  `forwardUserToken: false` (or `"false"`) turns it off and never asks the hook. Removed:
  `forwardEndUser`, `END_USER_HEADER`, `currentEndUserWebId`, the `x-linked-end-user` header.
  The module still imports neither `@_linked/auth` nor `CallContext`.
- `src/tests/remote-dataset.test.ts`: the end-user suite became the user-token suite (both
  headers beside the bearer, the hook's arguments, a new proof per request; nothing in a system
  context, for an anonymous request, outside a call or without the hook; a broken hook; the
  option off; no token or proof in an error message; the browser-safety check now also refuses an
  import of `@_linked/auth`). `remote-dataset-graphs.test.ts`: the graph query carries the user's
  headers.
- `readme.md`: the url form's user token, what a data server verifies, the warning (the token
  reaches whichever server `url` names; `forwardUserToken: false` for one you do not trust).
- `.changeset/user-token-to-data-server.md`: minor.

### Verification

```
$ NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/remote-dataset.test.ts src/tests/remote-dataset-graphs.test.ts
Tests:       54 passed, 54 total
$ npm test
Test Suites: 2 skipped, 33 passed, 33 of 35 total
Tests:       2 skipped, 485 passed, 487 total
$ npx linked build
✔ Build successful
$ git grep -n 'x-linked-end-user\|END_USER_HEADER\|forwardEndUser\|currentEndUserWebId' -- src readme.md
(nothing)
```

`npx changeset status --since=origin/dev`, in a plain clone of this branch (in the worktree,
changesets finds Create Now's workspace root first):

```
Packages to be bumped:
- minor
  - @_linked/server
```

CN's gateway spec and regular set with this checkout and auth's: CN report 151.

### Deviations

None from the sub-plan.

### Follow-ups

- Refresh of the user's token, sign-ins without an issuer token, guests → Create Now backlog 117.

## Details

The hook is read from `globalThis`, as the call context is, so the store stays browser-safe and
works with two copies of `@_linked/auth` in one process. `RemoteDataset`'s ping (`init`) goes
through `post` and so carries the user token when a request context has one; CN's gateway ignores
it there.
