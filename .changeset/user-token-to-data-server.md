---
'@_linked/server': minor
---

`RemoteDataset`'s url form sends the signed-in user's own Solid-OIDC access token instead of their
WebID: for a query made in a user's HTTP request it asks `@_linked/auth`'s hook
(`globalThis[Symbol.for('@_linked/auth:userTokenHeaders')]`, exported as `USER_TOKEN_HEADERS_HOOK`)
and sends `x-linked-user-token` (`USER_TOKEN_HEADER`) with a fresh `DPoP` proof for that request.
`forwardUserToken: false` turns it off.

**Breaking:** `x-linked-end-user` is no longer sent; `forwardEndUser`, `END_USER_HEADER` and
`currentEndUserWebId` are removed. A data server that read the WebID header verifies the token
with `@_linked/auth`'s `verifySolidAccessToken` instead.
