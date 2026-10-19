---
'@_linked/server': patch
---

`POST /admin/sync-shapes` now answers which packages it reloaded (`reloaded`) and the node shapes registered afterwards (`shapes`), refuses (400) package names that are not valid npm names, `@_linked/*` packages, or neither the app nor one of its direct dependencies, and times out a hung sync (`LINKED_SHAPE_SYNC_TIMEOUT_MS`, default 120 s) or source reload (`LINKED_SOURCE_RELOAD_TIMEOUT_MS`, default 60 s) so the queue is released. The README documents the control channel and the side effects of a reload and a restart.
