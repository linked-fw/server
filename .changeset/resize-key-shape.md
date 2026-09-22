---
'@_linked/server': patch
---

Fix `/resized/*` for `LocalFileStore`: resolve the source URL back to the right key, and write the resized file beside it.

The source guard added in the previous release derived one storage key from the
source URL. That is correct for `S3FileStore`, which serves a key directly under
its `accessURL` — but `LocalFileStore` serves `accessURL + '/uploads/' + key`,
so a file stored as `photo.jpg` is served at `/uploads/photo.jpg` and the
derivation produced `uploads/photo.jpg`. `fileExists` then returned false and
**every remote-branch resize 404'd on a LocalFileStore deployment**. The tests
covered only a store shaped like S3, which is why this shipped.

`IFileStore` has no URL-to-key inverse, so `resolveResizeSource` now returns both
candidate shapes and the route takes the first the store actually holds. It stays
fail-closed: a path matching neither is still refused without any request, and it
costs one extra `fileExists` in the local case.

The same mismatch was on the write side, and predates the guard: the destination
key was derived from the URL path, so a `LocalFileStore` wrote resized files to
`data/uploads/uploads/resized/` — a nested duplicate of the uploads folder. It is
now derived from the matched key, giving `resized/photo_w60.jpg` locally and the
unchanged `uploads/resized/photo_w60.jpg` for S3.

Covered by tests against a real `LocalFileStore` rather than an in-memory stand-in,
which is the gap that let the first version through.
