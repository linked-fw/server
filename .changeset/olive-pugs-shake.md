---
'@_linked/server': patch
---

Use one Vite-dev test for the entry bootstrap and the route assets. A production Vite build served from a config that still carries `server.vite` was given the dev preamble (importing `/@vite/client`, absent in production) instead of the entry script, while the route preloads correctly took the production path — so the page never hydrated. `isViteDevServer` in `utils/bootstrapEntry` is now the single decision, used by the bootstrap, the route preloads and the `__viteDev` asset marker.
