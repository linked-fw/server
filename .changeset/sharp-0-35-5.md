---
'@_linked/server': patch
---

Require sharp `^0.35.5`. The previous `^0.35.4` range still admitted 0.35.4, which bundles a librsvg affected by CVE-2026-96889 (GHSA-wq5f-xc86-pv6w). 0.35.5 ships libvips 8.18.7 / librsvg 2.63.2 and is the first release outside every open sharp advisory, including the libvips one (GHSA-f88m-g3jw-g9cj) and the libheif one (GHSA-rgj7-g3m4-5g8c).
