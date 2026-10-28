---
'@_linked/server': patch
---

`POST /admin/sync-shapes` answers 200 with `shapeCheck.failed` when the shape check throws and both syncs succeeded (it answered 500). The sync-pin warning counts a sub-shape under the target class it declares, so a sub-shape with its own class is no longer reported as its parent's; `owl:Restriction` is watched with the ontology term classes.
