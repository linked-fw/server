---
'@_linked/server': patch
---

The render path now reuses the dev/build decision `start()` makes instead of re-deriving it from a
manifest field that was never set. A server started outside development with a Vite build on disk
now boots the built entry and preloads route chunks, instead of emitting the Vite dev preamble
next to the built CSS.
