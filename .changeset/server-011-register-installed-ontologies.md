---
'@_linked/server': minor
---

At boot and on `POST /admin/sync-shapes`, every linked package the server discovered in the app's
dependency tree registers its ontologies (core `registerInstalledOntologies`) before the ontology
sync and the shape check, so a package the app only deep-imports shape files from
(`@_linked/schema/shapes/Person`) is synced and checked too.
