---
'@_linked/server': minor
---

The server ontology moves from `http://lincd.org/ont/lincd-server/` to `https://linked.cm/ont/server/`, the first-party scheme every public package uses (`https://linked.cm/ont/{publicSlug}/`, next to its shapes at `https://linked.cm/shape/server/`).

No data migration is needed. No stored data is typed with these terms (`LincdServer`, `LincdAPI`, `LincdWebApp`, `hasAPI`, …). The only store triples that carried them are the synced shape descriptions of `LinkedServer`, `LincdAPI` and `LincdWebApp` (`sh:targetClass`, `sh:path`); boot sync deletes and recreates each registered shape's description, so they move to the new IRIs the next time the server starts. With `syncShapesOnBoot: false` they keep the old IRIs until the next sync. The prefix key (`lincd-server`) and the `ontologies/lincd-server` module are unchanged; code that hard-codes `http://lincd.org/ont/lincd-server/` must be updated.
