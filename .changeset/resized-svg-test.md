---
'@_linked/server': patch
---

Cover `GET /resized/*` with an SVG source.

The route had no test at all. These assert on the BYTES and the KEY rather than
the status code, because the half that matters is silent: writing PNG bytes under
a `.svg` key still returns 200, and only misbehaves on the next request, when the
cache-hit path types the response `image/svg+xml` from that extension.

Both branches are covered — the `src`-parameter branch and the uploads branch —
because the bug was in both, for two different reasons. A third case pins a JPEG
source as staying a JPEG, so the rasterization cannot quietly become
unconditional.

Verified against the reverted fix: both SVG cases fail, the JPEG case passes.
