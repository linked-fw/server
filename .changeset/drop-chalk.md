---
"@_linked/server": patch
---

Drop the `chalk` dependency. Log colouring now uses Node's built-in `util.styleText`, which honours TTY detection, `NO_COLOR` and `FORCE_COLOR` the same way. This avoids chalk 5+, which is ESM-only.
