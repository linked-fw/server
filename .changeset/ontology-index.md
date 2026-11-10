---
"@_linked/server": major
---

The ontology is registered by `src/ontologies/index.ts` (core's `registerOntologies`), which the package entry imports; the package registers no prefix (an app's prefix map, `linked.app.json`, holds the prefixes; the ontology's data suggests one). `src/package.ts` exports `registerOntologies` instead of `linkedOntology`. Requires the `@_linked/core` major with `registerOntologies`. Removed: `ontologies/server.register`, `ontologies/lincd-server.register`, the `dataFiles` and `loadData` exports of `ontologies/server`, and the deprecated `lincd-server` prefix. The boot sync's source-package loader imports `src/ontologies/index.ts`.
