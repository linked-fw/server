---
"@_linked/server": patch
---

The boot ontology sync log no longer has a "(default graph: the store has no graph queries)"
case: core's ontology sync refuses such a store instead of falling back (core report 080), which
the server reports as a failed ontology sync. The unused `fallback` field is gone from the
`OntologyCore` type.
