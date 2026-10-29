---
'@_linked/server': minor
---

The boot's ontology and shape syncs (and `POST /admin/sync-shapes`) follow the app's storage
routing through core's routed syncs: each package's graphs go into every dataset the routing needs
them in, a graph routing no longer sends to the default dataset is dropped there, and one left in
another dataset is reported. With pins the boot logs one line naming the target datasets; the
earlier warning that the syncs write into the default dataset only is gone.

New `LINKED_GRAPH_WRITER=app|host`: under `host` the app writes no shape or ontology graph (at boot
or on `POST /admin/sync-shapes`, which then answers `skipped: 'host-writer'`), and
`GET /admin/routes` reports `graphWriter`. New `POST /admin/graph-content {packages?, reload?}` on
the admin channel answers, writing nothing, each package's shape and ontology graph and the app's
own shape graph as `{graph, mediaType, text, hash, sources}`: the exact bytes and hash the
`'package'`-mode sync writes. `POST /admin/sync-shapes` and `LINKED_SYNC_*_ON_BOOT` stay.
