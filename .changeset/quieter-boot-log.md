---
"@_linked/server": minor
---

Quieter boot log:

- The ontology and shape graph sync lines list the packages written and count the unchanged ones (`shape graph sync: written dep; 3 unchanged; app graph unchanged`), instead of listing every skipped package.
- `shape check: …` is logged only when the check has findings.
- The routing-pin warning is logged only for a boot sync that runs: `syncPinWarning` takes `{shapeSync, ontologySync}` and watches only the shapes those syncs write, so a boot with `syncShapesOnBoot: false` does not warn. A store without an `id` is named by its endpoint's dataset (`FusekiStore "cn-main"`).
