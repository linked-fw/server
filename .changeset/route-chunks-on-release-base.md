---
'@_linked/server': minor
---

Serve a route's preloaded chunks from the release base, not from the app's own
origin. `preloadScripts` and `preloadStyles` are now composed the way the
`main.js`/`main.css` entry tags already are — `<base>/public/bundles/<file>`,
with the base resolved once at boot from `STATIC_ACCESS_URL`, the release
manifest, or the file store. A release published to a CDN no longer renders a
page that asks that CDN for its entry bundle and this server for its route
chunks.

Same-origin deployments are unaffected: with no `STATIC_ACCESS_URL` and no
release manifest the base is empty and the URLs stay origin-relative, under the
`/public` mount the server already serves the bundle directory from. Cross-origin
route assets need `crossorigin` on their links, which
`@_linked/server-utils` 1.3.0 adds — hence the bumped range.
