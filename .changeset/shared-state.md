---
"@_linked/server": minor
---

A second copy of this package in one process no longer falls back to defaults: `server.rawQueries`, `server.rpcExposure` and the host's query catalog resolver live on `globalThis` (core's `sharedState`), and the process setup (cookie-jar `fetch`, `process` error listeners) runs once per process. `RemoteDatasetError`, its two subclasses and `FatalStartupError` are branded, so `isLinkedError(err, RemoteDatasetUnreachableError)` from `@_linked/core` matches one thrown by another copy. Requires `@_linked/core` 2.36.0.
