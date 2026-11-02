---
'@_linked/server': patch
---

In dev, the shape generator for the app's own packages and the loading of a linked package's index go through core's `importPackageModule` (`@_linked/core/utils/importPackageModule`) instead of Vite's `ssrLoadModule`. Under `linked start` that is the host module loader, which gives each specifier the copy the app's own import gets, so an app that installs `@_linked/core` from npm no longer loads a second, Vite-evaluated core at boot (`[linked] 2 copies of @_linked/core's shape registry have loaded in this process`). Without a host loader the server keeps `ssrLoadModule` when it runs with Vite, and Node's `import()` otherwise. Requires `@_linked/core` 2.47.0 or later.
