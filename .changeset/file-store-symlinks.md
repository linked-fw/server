---
"@_linked/server": minor
---

`LocalFileStore` path containment now resolves symlinks: the base folder and the target (or its nearest existing ancestor, following a dangling link) go through `fs.realpath` before the comparison, so a symlink inside the store that points out of it is refused on every method. `getShapes` on the default provider stays internal (not callable over RPC); clients read the shape index through `/api/all-shapes`.
