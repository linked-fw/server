---
'@_linked/server': minor
---

The server syncs the class hierarchy of every registered ontology into its app data and runs core's shape check before its shape sync, at boot and on `POST /admin/sync-shapes`, whose answer gains `ontologies: {written, skipped}` and `shapeCheck: {errors, warnings}`. The boot's ontology sync follows the shape sync's switches; `LINKED_SYNC_ONTOLOGIES_ON_BOOT=false` turns off only it. The server's own ontology data is Turtle (`data/server.ttl`), and the server no longer calls `autoLoadOntologyData`.
