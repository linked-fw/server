---
'@_linked/server': patch
---

`LocalFileStore` keeps dashes in a key instead of collapsing runs of them.

The sanitiser's preserved character class left `-` out, so a run of dashes
became one. Rollup's default base64 hash alphabet includes `-`, so an entry
whose hash starts with one meets the separator as `--`:
`shapeCodeGenerator--2JmNvrO.js` was stored as `shapeCodeGenerator-2JmNvrO.js`.
That is a different key from the one baked into the bundle, so the asset 404s —
and `publish-app`, which requires a release store to keep keys verbatim,
rejected the whole release.
