---
'@_linked/server': minor
---

`POST /admin/sync-shapes` is removed from the admin channel. A host that changed an app's shape
code asks `POST /admin/graph-content {reload: [packages]}`: it reloads those packages (in dev),
registers the ontologies again, runs the shape check and answers the content of the app's graphs,
writing nothing; the host writes them (`LINKED_GRAPH_WRITER=host`). The route answers 404, and
`ShapeSyncResult`, `parseSyncShapesBody`, the `syncShapes` admin handler and
`syncOntologiesThenShapes` are gone.

The env boot flags `LINKED_SYNC_SHAPES_ON_BOOT` and `LINKED_SYNC_ONTOLOGIES_ON_BOOT` are removed.
The boot syncs the shapes and the ontologies when the app writes its own graphs
(`LINKED_GRAPH_WRITER` unset or `app`) and `linked.config` does not set `syncShapesOnBoot: false`,
the one switch for both. `shapeSyncOn(configFlag)` takes the config switch only;
`bootSyncsOntologies` is gone.
