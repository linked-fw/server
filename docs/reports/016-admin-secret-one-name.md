---
summary: >
  The host control channel reads its secret only from `APP_ADMIN_SECRET` and the
  `x-app-admin-secret` header. The `CN_APP_ADMIN_SECRET` and `x-cn-admin-secret` fallbacks of
  report 015 are removed (the owner: no legacy apps). Minor changeset, listed as breaking.
packages: [server]
---

# 016 — One name for the admin secret

Source: CN plan 071 follow-ups; the owner's rules of 2026-10-24 (no legacy apps, one way to state
things).

## What

- `src/utils/adminChannel.ts`: `resolveAdminSecret(env?)` returns `APP_ADMIN_SECRET` or
  `undefined`. A request is checked against the `x-app-admin-secret` header only.
- Removed: `LEGACY_ADMIN_SECRET_ENV`, `LEGACY_ADMIN_SECRET_HEADER`, the once-per-process
  deprecation warnings, and the `warn` handler of `registerAdminRoutes`.
- Readme §Host control channel: the paragraph on the deprecated names is gone.
- Tests: `CN_APP_ADMIN_SECRET` alone opens no channel; the secret sent only as
  `x-cn-admin-secret` gets 401; a wrong `x-app-admin-secret` next to a right old header gets 401.
- Changeset `admin-secret-one-name.md` (minor, breaking list).

## Verification

Worktree `~/web/wt/cngen`, own Fuseki `ghcr.io/linked-fw/fuseki:6.2.0-2` on :3315 (compose
project `fuseki-cngen`), `FUSEKI_TEST_PORT=3315`.

```
FAIL src/tests/two-copies.test.ts        (backlog 002 item 4, as before)
Test Suites: 1 failed, 33 passed, 34 total
Tests:       466 passed, 466 total
Time:        25.236 s
✔ Build successful
```

`npx tsc -p tsconfig-tests.json --noEmit`: clean. An independent review found only low findings
(comment wrap, changeset wording); both were applied.

## PR

- What changed: the control channel reads only `APP_ADMIN_SECRET` and `x-app-admin-secret`; the
  `CN_APP_ADMIN_SECRET` and `x-cn-admin-secret` fallbacks, their warnings, the `LEGACY_*`
  constants and the `warn` handler are removed. Minor changeset with a breaking list.
- Verification: `npm test` and `npx linked build` on own Fuseki :3315.

  ```
  FAIL src/tests/two-copies.test.ts        (backlog 002 item 4, as before)
  Test Suites: 1 failed, 33 passed, 34 total
  Tests:       466 passed, 466 total
  ✔ Build successful
  ```
- Deviations: none.
- Follow-ups: CN stops stamping `CN_APP_ADMIN_SECRET` and sending `x-cn-admin-secret` (CN's own
  PR, recorded in its report).
