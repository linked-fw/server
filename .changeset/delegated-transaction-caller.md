---
"@_linked/server": patch
---

A store transaction started in a delegated call (`runAsDelegate`, `@_linked/server-utils` 1.18) is bound to the user the delegate acts for, the same identity as that user's own request, instead of `system`. `RemoteDataset` sends no user token for a delegated call: it has a user and no session token.
