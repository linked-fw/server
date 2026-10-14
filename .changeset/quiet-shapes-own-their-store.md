---
'@_linked/server': patch
---

Stop server boot from deleting SHACL declarations owned by other producers in a
shared app-data dataset. Boot now materializes each shape registered by the
current process independently and preserves the existing `syncShapesOnBoot:
false` opt-out.
