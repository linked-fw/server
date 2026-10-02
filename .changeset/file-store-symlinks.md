---
"@_linked/server": minor
---

`LocalFileStore` path containment resolves symlinks: the base folder and the target (or its nearest existing ancestor, following a dangling link) go through `fs.realpath` before the comparison, so a key that reaches outside the store through a symlink is refused on every method.

`getShapes` on the default provider is not declared callable (it answers 501 in `enforce` mode); clients read the shape index through `/api/all-shapes`. `dispose` is a reserved name: the server calls it when it reloads providers, and no RPC reaches it in either `rpcExposure` mode.
