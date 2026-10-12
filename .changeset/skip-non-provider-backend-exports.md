---
'@_linked/server': patch
---

Only construct the provider classes a package's backend entry exports. Every export used to be
passed to `new`, so a non-class export — `@_linked/auth`'s `SESSION_COOKIE_NAME` string — logged
`[linked] @_linked/auth SESSION_COOKIE_NAME constructor failed: providerClass is not a constructor`
at every boot. Constants, plain functions and arrow functions are now skipped silently; classes
extending `BackendProvider`, and any other `class`, are constructed as before.
