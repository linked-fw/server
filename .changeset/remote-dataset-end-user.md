---
'@_linked/server': minor
---

`RemoteDataset`'s url form sends the signed-in user's WebID of the current call as `x-linked-end-user` (exported as `END_USER_HEADER`). A system context, an anonymous request and code outside any call send none; `forwardEndUser: false` turns it off.
