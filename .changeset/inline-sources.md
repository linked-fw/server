---
'@_linked/server': patch
---

Embed the TypeScript sources in the published sourcemaps (`inlineSources`). The maps pointed at
`src/*.ts`, which the tarball does not contain, so Vite dev warned that each sourcemap "points to
missing source files".
