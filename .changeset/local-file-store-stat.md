---
'@_linked/server': minor
---

`LocalFileStore` accepts the new `SaveFileOptions` third argument of `saveFile`
(still accepting a positional mime-type string) and gains `statFile()`, which
returns the size and a sha256 of a stored file, or `null` when it does not
exist, for verify-after-upload. A local file has no headers, so `cacheControl`
and `metadata` are accepted and ignored.

Core reports an unspecified `preventDuplicates` as `undefined` and applies no
default of its own, so this store keeps applying its own: a caller that says
nothing still gets the random file-name suffix, and only an explicit
`preventDuplicates: false` overwrites an existing name.
