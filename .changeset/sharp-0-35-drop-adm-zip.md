---
'@_linked/server': minor
---

Upgrade `sharp` to ^0.35.4 and drop the unused `adm-zip` dependency.

`sharp` was pinned to `^0.34.4`, which resolves to a build carrying the libvips
advisories CVE-2026-33327, -33328, -35590 and -35591. This is not a
tooling-only exposure: `LinkedServer` imports `sharp` at module top level and
registers `GET /resized/*` **before** the `apiOnly` guard, so the handler is
live in an API-only deployment too. It fetches a URL and pipes the bytes
straight into `sharp()`, which makes those the only advisories in this package
reachable from a request.

`^0.35.4` is a semver-major for sharp, but the surface used here —
`sharp(buffer|path)`, `.metadata()`, `.resize(w, h)`, `.toFormat(fmt, opts)`,
`.toBuffer()` and `.toFile()` — is unchanged between the two. Verified by
exercising exactly those calls against jpeg, png and webp, through both the
buffer branch and the `toFile` branch. sharp 0.35 requires Node >= 20.9.

Flagged `minor` rather than `patch` because sharp 0.35 drops some older
platform prebuilds; consumers on an unusual target should check that a binary
exists for theirs.

`adm-zip` is removed: it is declared in `package.json` and referenced nowhere in
the package. It carried three advisories of its own, so this is three fewer for
every consumer at the cost of one line.

Note for whoever picks it up next: `resizeImage` still fetches an arbitrary
`req.query.src` server-side. The `// TODO: restrict resizing to images that are
stored by LinkedFileStorage` above it is an unfixed SSRF and is arguably a
bigger problem than the libvips CVEs this change closes. Deliberately left
alone here rather than mixed into a dependency bump.
