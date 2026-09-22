---
summary: >
  /resized/* still takes `?src=` as a full URL and fetches it over HTTP, even
  though the source is now required to be an image this app already stores. The
  fetch is a network round-trip for bytes the process can read directly, and it
  keeps a URL-shaped API for what is really a store key. Collapsing it to
  getFile(key) removes the last of the SSRF surface and deletes code, but it
  changes the route's contract, so it needs a major.
---

# 001 — Resize by store key instead of fetching a URL

## Where this came from

`?src=` used to be handed straight to `fetch`, which made every deployment an
open proxy into its own network — and because the fetched bytes were written
into the *public* file store and the caller redirected to them, a reachable
internal resource was persisted rather than merely leaked.

That was fixed by restricting `src` to the configured file store: parsed-origin
comparison against `LinkedFileStorage.accessURL`, a `fileExists` check on the
derived key, a fetch of a URL rebuilt from that key, and `redirect: 'error'`
plus a timeout and a size cap. See `src/utils/resizeSource.ts`.

That fix was deliberately the conservative one, because it is backward
compatible. This item is the version that is actually correct.

## The problem with what is there now

Once `src` is guaranteed to name an image in the store, the URL is a store key
with extra steps:

- **The fetch is pointless.** `resizeImage` calls
  `LinkedFileStorage.fileExists(key)` and then performs an HTTP request to
  retrieve bytes that `LinkedFileStorage.getFile(key)` would return directly.
  For a local store that is a loopback request to read a file already on disk.
- **It keeps a fetch that has to stay correct.** Origin comparison, redirect
  refusal, credential rejection, the size cap and the timeout all exist to make
  an outbound request safe. None of that code needs to exist if there is no
  outbound request.
- **The API lies about what it accepts.** Callers pass a full URL, but only one
  origin's URLs are valid. A key says what is meant.

## What the change looks like

Replace the `src`-fetch branch with a key lookup:

```ts
const bytes = await LinkedFileStorage.getFile(key);
```

`resolveResizeSource` still has a job during a deprecation window — turning a
legacy full URL into a key — but `fetchStoredImage`, and with it the timeout,
the size cap and the redirect handling, can go.

## Why it is not done yet

It is a breaking change to the route's contract. Anything passing
`?src=<full URL>` keeps working only if the URL-to-key translation is retained,
and anything passing a third-party URL — which no longer works anyway after the
SSRF fix — breaks visibly rather than silently.

## First open questions

1. Is `?src=` as a full URL used by real consumers, or is the local branch
   (`/resized/<path>`) the only one anyone uses? That decides whether this needs
   a deprecation window at all.
2. Should the key form be a new parameter (`?key=`) so both can coexist for a
   release, or should `src` simply start accepting a key as well as a URL?
3. The other branch of the same route reads from `<cwd>/data/uploads` directly,
   bypassing `LinkedFileStorage` entirely, so it cannot work for an S3-backed
   app at all, and its cache directory is never created because the `mkdirSync`
   is commented out. These probably want doing together, since both end at "the
   route reads and writes through the store".

## Related

- `src/utils/resizeSource.ts` — the guard this would let go.
- `src/tests/resized-images.test.ts` — the behaviour that must keep passing.
