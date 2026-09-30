---
'@_linked/server': patch
---

Add `shapes/index`, a side-effect-only module that registers every shape this package defines, and have the package entry import it instead of listing shapes one by one. Hosts and consumers can now load `@_linked/server/shapes/index` to get the package's full shape set registered without pulling in anything else, and a shape added later is picked up by the entry automatically.
