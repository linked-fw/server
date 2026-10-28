---
'@_linked/server': patch
---

Boot loading reads a `package.json` without `linked.kind` by the retired flags (`linkedPackage: true` is a `library`, `linkedApp: true` an `app`), so packages published before `linked.kind` still load until they are republished.
