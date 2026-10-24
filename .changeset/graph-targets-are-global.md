---
'@_linked/server': minor
---

The graph targets are one global setting (`@_linked/core` 2.42). At boot the server reads `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH` (an invalid value is still a fatal boot error) and calls core's `setGraphTargets` once, before the stores are initialised and before the syncs; it no longer sets targets on each store. `GET /admin/routes` reports the setting as `graphTargets` (`{ontologyGraph, shapeGraph}`) next to `graphTargetEnv`; the per-dataset `ontologyGraph` / `shapeGraph` fields are gone. New boot warning: when routing pins `NodeShape` / `PropertyShape` or the ontology term shapes (`rdfs:Class`, `owl:Class`, `rdf:Property`, `owl:ObjectProperty`, `owl:DatatypeProperty`, `owl:AnnotationProperty`) to a dataset other than the default one, the server names them and the dataset and says the syncs write into the default dataset only. `applyGraphTargetsFromEnv(env)` takes no stores any more. Requires `@_linked/core` 2.42.0.
