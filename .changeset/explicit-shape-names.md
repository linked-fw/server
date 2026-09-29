---
'@_linked/server': patch
---

Name the `LincdAPI`, `LinkedServer` and `LincdWebApp` shapes explicitly. Their IRIs were derived
from the class name, which an esbuild pass over the compiled JS (Vite's dev-SSR `define` step)
renames to `LincdAPI2` / `LinkedServer2`, so dev and production minted different IRIs.
