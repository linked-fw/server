---
'@_linked/server': patch
---

Load the application's own backend in the compiled runtime.

`indexBackendProviders` imports `<app>/backend` by package name. A
self-reference resolves only from inside the package that declares it, and this
code runs from `node_modules/@_linked/server` — so Node reported
`Cannot find package '<app>'` and **every one of the application's Providers
silently failed to register**, leaving each `Server.call` on one of its shapes
to 501.

Development was unaffected: the Vite branch already special-cased the app's own
backend. The compiled runtime now does the same, resolving `lib/backend.js` by
path and falling back to `src/backend.ts`.
