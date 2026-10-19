---
"@_linked/server": minor
---

The server enforces and reports the `'signed-in'` callable level from `@_linked/server-utils` 1.14: a `'signed-in'` method answers 401 without a session. A method declared with the deprecated alias `'user'` is treated exactly the same, and `resolveCallable` reports it as `'signed-in'`. Requires `@_linked/server-utils` ^1.14.0.
