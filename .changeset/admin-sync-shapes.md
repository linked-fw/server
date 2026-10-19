---
'@_linked/server': minor
---

Add `POST /admin/sync-shapes` to the host control channel (`CN_APP_ADMIN_SECRET`). It re-syncs the app's registered shapes into its app data exactly as the boot does (core `syncShapes`, writing only shapes whose stored hash differs) and answers `{written, orphanScope}`; a failed sync answers 500 `{error}`. The optional body `{packages: [...]}` names packages whose source changed on disk: in dev their modules are invalidated in Vite and their backends reloaded first, so a shape file the host has just written is registered before the sync. Source reloads (`onSourceChange`) now run one at a time, and `LinkedServer.resyncShapes()` is available to code in the process.
