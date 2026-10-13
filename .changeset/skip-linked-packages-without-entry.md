---
'@_linked/server': patch
---

At boot the server no longer tries to import a workspace linked package that has no JavaScript entry (no `main`, `module` or root `exports`), such as the pure-CSS `@_linked/css`. Before, a pure-CSS package checked out as a workspace member logged `Error loading '…': Failed to resolve entry for package` on every start. The new `hasModuleEntry(packageJson)` in `utils/linkedDependencies` makes that decision.
