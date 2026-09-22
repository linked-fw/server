---
'@_linked/server': minor
---

`/resized/*` only resizes images the app already stores, and both branches agree on the cache key.

**The SSRF.** `?src=` was handed straight to `fetch`, with the check that should
have guarded it sitting commented out above a `TODO`. Any unauthenticated caller
could aim the server at cloud metadata, `localhost`, or a private range — and
the route is registered *before* the `apiOnly` guard, so this was live in
API-only deployments too. Worse than a read: the fetched bytes were written into
the **public** file store and the caller redirected to the public URL, so a
reachable internal resource was persisted, not merely leaked. Differing status
codes (404 connection failed, 400 connected-but-not-an-image) made it a usable
port scanner even when nothing decoded.

`src` must now resolve to a key inside the configured store. `resolveResizeSource`
compares **parsed origins** — a `startsWith` check is defeated by
`https://cdn.example.com.evil.com` — rejects embedded credentials and scheme
downgrades, derives the key, and the route confirms `fileExists` before anything
is requested. The URL that is finally fetched is **rebuilt from the validated
key**, never the caller's string, so encoding and fragment tricks cannot
reintroduce what the check removed.

Three limits come with it, because an allowed source should still not be able to
exhaust the process: a 10s timeout, a 25MB cap enforced while streaming rather
than after buffering, and `redirect: 'error'`. The redirect rule is not
optional — `fetch` follows redirects by default, so a 302 would undo the origin
check one hop later.

Refused sources return 400 `Unsupported image source`; a well-formed store URL
for a file that is not there returns 404, as before.

**The cache key.** The underscore in a resized name was emitted by the *width*
segment, so a height-only request produced `logo_h30.png` on the local branch
but `logoh30.png` on the remote one — two halves of one route disagreeing on the
key for the same request. The separator is now emitted once, before either
dimension, so both read `logo_h30.png`. Height-only entries cached under the old
name are orphaned: they still resolve if a URL was handed out, but the next
request generates the new key. Width-only and width+height keys are unchanged,
which is the overwhelming majority.

Tests 126 → 137.
