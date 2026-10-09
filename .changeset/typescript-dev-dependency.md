---
"@_linked/server": patch
---

typescript is no longer installed into consumers by this package: it was listed as a runtime dependency, but only the build uses the compiler, so it moved to devDependencies.
