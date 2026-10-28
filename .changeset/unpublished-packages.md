---
'@_linked/server': minor
---

The packages an app lists in `linked.unpublishedPackages` (and, transitively, the lists of those packages) are its direct dependencies: boot loading finds them by npm name (npm's workspace link into `packages-local/`, else the checkout there), the shape sync's reload check accepts them, and the shape check reads each list as dependencies. Lists are read with `@_linked/cli/installed-packages`' `unpublishedPackages`, so a malformed list is an error.
