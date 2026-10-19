---
'@_linked/server': patch
---

`RemoteDataset` no longer imports `@_linked/server-utils/utils/CallContext` (which imports `node:async_hooks`): it reads the call context from the store that module shares on `globalThis`, so the store loads in the browser again.
