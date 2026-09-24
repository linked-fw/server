---
"@_linked/server": patch
---

Honor `SaveFileOptions.preservePath` in `LocalFileStore` so locally published release artifacts retain their exact manifest object keys, including case, `@`, and repeated dashes. Unsafe absolute, Windows-style, empty-segment, and traversal paths are rejected, while ordinary uploads keep their existing filename sanitisation behavior.
