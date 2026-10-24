---
'@_linked/server': minor
---

`LINKED_ONTOLOGY_GRAPH` and `LINKED_SHAPE_GRAPH` set where the stores keep the packages' ontology data and shapes (core 2.41's graph targets): `package` (default), `default`, or the absolute IRI of one shared graph. The server checks them at boot (an invalid value stops the boot, naming the variable) and fills them into every store that takes graph targets, where the store's own options leave them unset; a store that takes none (`RemoteDataset`) runs `package`, with a warning when the variables ask for another mode. `GET /admin/routes` reports each store's `ontologyGraph` / `shapeGraph` and the variables (`graphTargetEnv`). The boot log names a shared graph or the default graph when the syncs wrote there, and `shapeGraphs` reports `target`. The ontology phase's `graphs` / `droppedGraphs` no longer list the inference probe's temporary graphs. Needs `@_linked/core` ^2.41.0.
