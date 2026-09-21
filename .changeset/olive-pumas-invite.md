---
'@_linked/server': patch
---

Match route `preloadChunks` against the Vite manifest case-insensitively, and warn when one resolves to nothing.

Apps carrying webpack-era lowercase chunk names (`['home', 'signin']`) matched nothing in a Vite manifest keyed by source path (`src/pages/Home.tsx`), so no preload tags were emitted at all — silently. Exact matching by source path and by path tail still wins; the case-insensitive basename match is only a fallback, anchored on the path separator so `home` cannot be answered by `MyHome.tsx`. An unresolved chunk name is now logged once per name, not once per request.
