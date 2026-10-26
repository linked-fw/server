---
summary: >
  @_linked/server part of Create Now's plan 080 step R2b: RemoteDataset's url form sends the
  signed-in user's own Solid-OIDC access token (`x-linked-user-token`) with a DPoP proof for each
  request, obtained from @_linked/auth's headers hook, instead of the unsigned
  `x-linked-end-user` WebID header. Lands together with Create Now's gateway change.
status: Plan
---

# 001 — The user's own token to the data server (Create Now plan 080, step R2b)

Master plan: Create Now `docs/plans/080-datasets-as-workspace-entities.md` (decisions D3c, M7);
CN sub-plan `docs/plans/082-datasets-cn-steps.md` §R2b and its gaps G3–G6. This repo's part is
small; it lands on the integration branch `dev` together with the CN landing of R2b and
`@_linked/auth`'s part (auth plan 002), never alone.

## Contracts

Copied from CN plan 082; a change is made there first.

- **C7 Tokens and env** (R2 → `@_linked/cli` app template, apps): one variable per slot,
  `DATA_SERVER_TOKEN_<SLOT>` (`slot.toUpperCase()`, `appData` → `DATA_SERVER_TOKEN_APPDATA`),
  `DATA_SERVER_URL` shared, `DATA_SERVER_TOKEN` removed; CN writes them into the clone's managed
  `.env` block. […] The user's token travels as `x-linked-user-token` (the user's Solid-OIDC
  access token, DPoP-bound, with its `DPoP` proof); `Authorization: Bearer` stays the connection
  credential (M7).
- **C11 User token** (R2b → apps; Logos later).
  - App side (`@_linked/auth`): the server keeps a session's issuer access token and its DPoP key
    server-side, keyed by the session id, never in a cookie; it installs
    `globalThis[Symbol.for('@_linked/auth:userTokenHeaders')]: (request, {method, url}) =>
    Promise<{'x-linked-user-token': string; DPoP: string} | undefined>`, which answers undefined
    once the token expires or for a session with no issuer token (password, email code, guest,
    dev). `@_linked/server`'s `RemoteDataset` (url form) calls it for each request with the
    request's method and full URL, unless `forwardUserToken: false` (or `"false"`), which
    replaces `forwardEndUser`; `x-linked-end-user`, `END_USER_HEADER` and `currentEndUserWebId` go.
  - Verifier and gateway: CN plan 082 C11 (not this repo).

## Scope

- `src/shapes/quadstores/RemoteDataset.ts`: in `post` (:430-456) replace the end-user block
  (:445-448) with a call to the hook for the current http call context (`currentCallContext`,
  :73-78, read from `globalThis` as today, so the module stays browser-safe and imports neither
  `@_linked/auth` nor `@_linked/server-utils`), passing `{method: 'POST', url: target}` (:439);
  set both headers when it answers. The ping (`init`, :258-280) goes through `post` and so
  carries the user token when a request context has one, as today with the WebID.
- Config (:41-60): `forwardEndUser` → `forwardUserToken` (same parsing, :234-236; field :216-217).
  Remove `END_USER_HEADER` (:67) and `currentEndUserWebId` (:85-90); export
  `USER_TOKEN_HEADER = 'x-linked-user-token'` and `USER_TOKEN_HEADERS_HOOK =
  Symbol.for('@_linked/auth:userTokenHeaders')`.
- A hook that throws or answers something else than two non-empty strings sends no user headers
  and logs one warning per process (the query still goes, as the connection alone).
- `readme.md:326, 358-370`: the url form's headers, `forwardUserToken`, what a data server must
  verify; the warning that the token reaches whichever data server the url names (DPoP binds it
  to that request, but an untrusted server should get `forwardUserToken: false`).
- Changeset: minor (removes `forwardEndUser` and two exports; small breaking change, shipped as a
  minor).

## Pitfalls

- The hook is async; call it per request, after `target` is known, never cache its answer (each
  DPoP proof has its own `jti`).
- The url passed must be exactly what is fetched (`target`), or the gateway's `htu` check fails.
- Keep the browser-safety test (`src/tests/remote-dataset.test.ts:400-405`): no import of
  `node:async_hooks`, `@_linked/auth` or `CallContext`.
- Never log or put the token or the proof in an error message (today's rule for the bearer,
  test :349).

## Tests

`src/tests/remote-dataset.test.ts`: the end-user cases (:371-417) become user-token cases: a
signed-in http context whose hook answers gets both headers alongside the Bearer; the hook gets
`POST` and the full target URL; system context, anonymous request, no context, and a hook that
answers undefined send neither; `forwardUserToken: false` / `'false'` send neither; a hook that
throws sends neither and the query still succeeds; the header key set of :84-87 is unchanged
without a user. Run `npx jest src/tests/remote-dataset.test.ts`, then the package suite and
`npx linked build`; in CN, `npm run typecheck:gate` and the regular set against this checkout.

## Verify

- `git grep -n 'x-linked-end-user\|END_USER_HEADER\|forwardEndUser\|currentEndUserWebId' -- src readme.md`
  → nothing (CHANGELOG and reports aside).
- `npx jest` green; `npx linked build` passes; `npx changeset status` lists `@_linked/server`
  minor.
- CN's `tests/integration/app-gateway-user-token.spec.ts` (R2b) passes with this checkout
  localized.

## Done when

`RemoteDataset` sends the user's token and proof from the hook, nothing names a user by WebID,
the readme and changeset are in, and the CN landing of R2b went in with it. Report: this repo's
`docs/reports/019-…` (next free), the plan deleted.
