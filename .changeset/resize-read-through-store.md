---
'@_linked/server': minor
---

`/resized/*` reads its source through the file store instead of fetching it, and the route is documented.

Once `src` had to name an image the store already holds, fetching its public URL
was a round-trip to ask a web server for a file this process can open — over the
loopback interface, for a `LocalFileStore`. The bytes now come from
`LinkedFileStorage.getFile`.

**The route makes no outbound HTTP request at all.** That retires the machinery
that existed to make one safe: `fetchStoredImage`, the 10s timeout, the 25MB
streaming cap and `redirect: 'error'` are all gone. The origin and existence
checks stay, because they decide *which* stored file a caller may address.

`?src=<full URL>` still works exactly as before — the URL is resolved to a key
and read from the store — so this is a minor, not the major the backlog item
assumed it would need.

Also: `resizedImagesPurpose` is registered at the point of use rather than as an
import side effect, so clearing the registry mid-process (as
`LinkedFileStorage.resetForTests()` does) can no longer leave `getStore`
throwing inside a request handler.

The readme gains a **Resizing images** section: both request forms, what is
refused and why, and how to point the derivative cache at a different store —
with the trade-off spelled out, since a local disk cache is per-instance and
dies with the container while an object-store cache is shared and survives
deploys.
