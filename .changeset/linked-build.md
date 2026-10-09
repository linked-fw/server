---
"@_linked/server": patch
---

The `build` script is now `linked build`, the same build CI and the release workflow already run, so a local build produces the published `lib/` (compiled output, copied `src` assets and rewritten ESM import specifiers). The `build-esm` and `copy-to-lib` scripts and the `copyfiles` dev dependency are removed, and the `@_linked/cli` dependency floor is raised to `^1.45.5`.
