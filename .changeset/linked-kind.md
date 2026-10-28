---
"@_linked/server": minor
---

Boot loading decides which installed packages are linked from their `linked.kind` (any kind but `app`), through `linkedKind(json)` in `@_linked/server/utils/linkedDependencies` (the twin of `@_linked/cli`'s). `linkedPackage: true` is no longer read. `discoverLinkedDependencies` takes an optional third argument, the test for a linked package (default `isLinkedPackageJson`). This package's own `package.json` says `"kind": "library"`, merged into its `linked.serverOnly`.
