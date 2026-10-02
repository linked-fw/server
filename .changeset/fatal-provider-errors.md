---
'@_linked/server': minor
---

A provider can refuse to let the server start. An error with an own `fatal: true` property thrown at boot — from a provider constructor, a backend module's top level, or a boot hook — is no longer isolated: it is logged as `[linked] <pkg> <hook>: fatal error, refusing to start: …`, `start()` / `initOnly()` reject with it, and the process exits with code 1. After boot (per-request hooks, lazy loads, HMR) it is logged as fatal and contained. Non-fatal errors are isolated as before. Adds `FatalStartupError` and `isFatalError` (`@_linked/server/utils/fatalError`, also exported from the package root).
