---
'@_linked/server': patch
---

`/resized/*` now serves SVG sources as PNG instead of failing.

Sharp can **read** SVG but has no SVG encoder, so every resize of an SVG threw:
the store-backed branch called `.toFormat('svg', …)`, and the uploads branch called
`.toBuffer()` with no explicit format, which defaults to the input's. Both now
rasterize to PNG.

The cache key follows the output rather than the source, in both branches. Writing
PNG bytes under a `.svg` key would also have served them as `image/svg+xml`, since
the cache-hit path types the response from that extension.

Also treats a zero-length buffer as a missing image rather than handing an empty
buffer to sharp.

Found by @abdipramana in #32, against an earlier version of this route. That PR
also carried an `askQuery` change which has since landed on main by another route,
and a fetch-based image read that no longer exists — the route now reads bytes
straight from the store. Only the SVG behaviour still applied, and it is
reimplemented here against the current structure rather than merged.
