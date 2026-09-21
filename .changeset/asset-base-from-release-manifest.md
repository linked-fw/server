---
'@_linked/server': minor
---

Derive the asset base URL from the release manifest.

`linked build-app` (`@_linked/cli` 1.19+) publishes a release under
`releases/<version>-<revision>/` and records where it was built for in
`public/bundles/linked-release.json`. The server now reads that manifest at boot
and renders its HTML entry tags against `destination.baseURL` — the very value
the bundle was built with as Vite's `base` — instead of requiring
`STATIC_ACCESS_URL` to be set to `<accessURL>/<releasePrefix>` by hand on every
release.

Precedence: development still uses a relative base; an explicit
`STATIC_ACCESS_URL` still wins over everything; the release manifest comes next;
and `LinkedFileStorage.accessURL`, then an empty base, remain the fallback.

Released as a minor rather than a patch because behaviour does change for one
group: an app that has a release manifest on disk and does **not** set
`STATIC_ACCESS_URL` used to serve its entry tags from the upload store's
`accessURL` and now serves them from the published release. That is the fix, but
it is a visible change in the rendered HTML. Every app without a manifest — and
every app that sets `STATIC_ACCESS_URL` — is byte-for-byte unchanged. A manifest
that is missing, unparsable, of an unknown `schemaVersion`, or without a
published destination (a Capacitor build writes an empty one) is ignored with a
warning and never blocks boot.
