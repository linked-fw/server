---
'@_linked/server': minor
---

`LocalFileStore` accepts the new `SaveFileOptions` third argument of `saveFile`
(still accepting a positional mime-type string) and gains `statFile()`, which
returns the size and a sha256 of a stored file, or `null` when it does not
exist, for verify-after-upload. A local file has no headers, so `cacheControl`
and `metadata` are accepted and ignored; `preventDuplicates` still defaults to
suffixing the file name, as before.
