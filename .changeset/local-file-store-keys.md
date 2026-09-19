---
'@_linked/server': minor
---

Fix `LocalFileStore.saveFile`: preserve the key, honour `basePath`, and report where the file landed.

`saveFile` went through `getUploadTarget`, which lowercases the name and always resolves against the server's upload
folder. Two consequences: a key whose case matters (a Vite content hash such as `main-hwqwrAvA.css`) was corrupted, and
a store built with a custom `basePath` wrote to the upload folder while `getFile`, `fileExists`, `deleteFile` and
`statFile` all read from `basePath` — so it could never read back what it wrote.

`saveFile` now resolves the target against the store's own `basePath`, like every other method, and keeps the name's
case. Unsafe characters are still replaced and a missing extension is still added from `mimeType`; lowercasing stays
where it belongs, in `@_linked/server-utils`' upload handling, which already sanitises a browser-supplied filename
before any store sees it.

New `saveFileWithPath()` returns `{storedPath, publicURL}`, so a caller can hand `storedPath` straight to
`statFile`/`getFile`. With `preventDuplicates: false` that path equals the path given, verbatim.

Minor rather than patch because behaviour changes for existing callers in two ways:

- a name containing uppercase characters is now stored with its case intact instead of lowercased. Callers that pass an
  already-lowercased name (which is what the HTTP upload path does) are unaffected.
- a store constructed with a custom `basePath` now writes into that folder instead of `./data/uploads`.

Unchanged: the default `basePath`, the suffixing default when `preventDuplicates` is unspecified, the returned URL, and
the two-argument `LinkedFileStorage.saveFile(path, buffer)` path.
