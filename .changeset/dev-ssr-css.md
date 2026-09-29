---
'@_linked/server': patch
---

Dev SSR styling fixes. A development server no longer reads a build manifest left on disk by an
earlier `vite build`, so it stops linking that stale built CSS next to Vite's live styles. The SSR
CSS collector skips `?direct` ids and files under Vite's `publicDir` (which failed with "Parse
failure" when loaded as a module) and loads each stylesheet once. The collected CSS is no longer
serialised into `assetManifest` as well as the inline `<style>`; that copy was about half of a dev page.
