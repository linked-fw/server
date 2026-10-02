---
'@_linked/server': minor
---

The server ontology's prefix label is now `server`, matching its namespace slug (`https://linked.cm/ont/server/`), so compaction emits `server:LincdAPI` where it used to emit `lincd-server:LincdAPI`. The ontology moves to `ontologies/server` (export `server`) and `ontologies/server.register`, and its data file to `data/server.json`, whose `@context` key and prefixed names now use `server:`. The IRIs themselves are unchanged.

Deprecated, still working: the `lincd-server` prefix stays registered as an alias, so `lincd-server:X` names still expand to the same IRIs; `ontologies/lincd-server` re-exports `ontologies/server`, `ontologies/lincd-server.register` registers the ontology, and `lincdServer` is the same object as `server`. Only the published `data/lincd-server.json` path is gone, renamed to `data/server.json`.

No IRI changes, so stored data is unaffected; any data written under the older `http://lincd.org/ont/lincd-server/` IRIs is still not migrated (clear dev datasets).
