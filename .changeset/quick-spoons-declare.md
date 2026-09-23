---
'@_linked/server': patch
---

Declare this package's server-only surface.

```jsonc
"linked": { "serverOnly": [".", "./shapes/*", "./server/*", "./utils/*"] }
```

A consuming application's client/server boundary check can now derive that this
package must not appear in a frontend bundle, instead of hardcoding its name.
That matters because this package is meant to be replaceable — a check that
knows it by name only holds for one arrangement of the framework, and a
replacement would inherit none of the protection.

Purely declarative: no code, no exports and no resolution behaviour changes.
