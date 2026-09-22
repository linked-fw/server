---
'@_linked/server': minor
---

`/resized/*` reads and writes through `LinkedFileStorage` on both branches, and the derivative cache has its own purpose.

The local branch hardcoded `<cwd>/data/uploads` for both the original and the
cached derivative. That only ever worked for a `LocalFileStore`: an app with its
uploads in S3 had nothing on local disk, so **every request to this branch
404'd**. It now reads the original from the `uploads` purpose and writes the
derivative through the store, so it works wherever the app keeps its files.

Three bugs go with it:

- The cache directory was never created. The `mkdirSync` that should have done
  it was commented out, and the `toFile` failure was swallowed with a
  `console.warn`, so on a deployment where `data/uploads/resized` did not exist
  every resize silently failed to cache and then 404'd with nothing to say why.
  No hand-rolled directory creation is needed now — `LocalFileStore.saveFile`
  makes its own parents.
- On a resize error the handler sent a 500 and then fell through to
  `res.sendFile`, a second send on the same response.
- A cache write failure is now logged rather than fatal: the resize succeeded,
  so the caller still gets its image and only the caching is lost.

**New purpose: `resizedImagesPurpose`.** A resize cache is not the same thing as
user uploads — uploads are originals and must be kept, derivatives are
reproducible and can be dropped or served from somewhere cheaper. Naming it
separately lets an app decide:

```ts
import { resizedImagesPurpose } from '@_linked/server/utils/resizedImagesPurpose';

// originals in S3, derivatives cached on the local disk
LinkedFileStorage.setStore(resizedImagesPurpose, new LocalFileStore('cache'));
```

Left alone it falls back to the default store, which is what the route did
before, so no app has to care unless it wants to.

The response contract is unchanged: this branch still answers `200` with the
image bytes rather than redirecting.
