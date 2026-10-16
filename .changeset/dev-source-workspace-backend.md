---
'@_linked/server': patch
---

In dev, a source workspace's backend is found from `src/` (`src/backend.tsx`, `src/backend.ts`, or its `exports` target mapped from `lib/esm` back to `src`), the way linked's Vite resolver loads it. An unbuilt workspace, whose `exports` name only `lib/esm`, no longer has its `src/backend.ts` silently skipped. Published packages and production are unchanged.
