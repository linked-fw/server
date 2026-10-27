---
summary: >
  Core no longer has the ontology sync's default-graph fallback (core report 080): a store
  without graph queries is refused, and the result has no `fallback` field. The server still
  types and reads it in its ontology sync log line; drop that branch. Low priority: it is never
  set, so the log only loses an unreachable wording.
packages: [server]
---

# The ontology sync's removed `fallback` field

`src/utils/ontologySync.ts` types core's `syncOntologies` result with `fallback?: true` (`:35`)
and, in the boot log line, prints "(default graph: the store has no graph queries)" when it is set
(`:222`). Core after 2.44.0 removed the fallback (core `docs/reports/080-package-kinds-and-npm-out-of-core.md`):
a store without graph queries now makes the sync throw, which the server already reports as
"ontology sync failed". Remove `fallback` from the structural type and the branch; keep the
older-core detection only if a core of 2.44.0 or older must still be supported.

The shape sync's own `fallback` (`syncShapes.ts:312,321`) is a different field and stays.
