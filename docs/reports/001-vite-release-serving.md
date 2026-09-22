---
summary: Two fixes that stood between a Vite-built application and a release it could actually
  serve — the entry tag was rendered as a classic script, and LocalFileStore rewrote the object
  keys a release is addressed by. Records what was wrong, why neither surfaced earlier, and the
  contracts they establish.
---

# Serving a Vite-built release

Two independent defects, both on the path from "a release exists" to "a browser runs it". Neither
could be seen from inside this package: the first needs a real Vite bundle, the second needs a
release actually published to a local store.

## 1. The entry tag was a classic script

**`LinkedServer.tsx` — [#51](https://github.com/linked-fw/server/pull/51)**

The SSR render passed the client entry to React as `bootstrapScripts`, which emits

```html
<script src="…/assets/index-abc123.js" async></script>
```

Vite always emits the client entry as an **ES module**. A browser handed module syntax in a
classic script refuses the file outright:

```
Uncaught SyntaxError: Cannot use import statement outside a module
```

So **no Vite production build could hydrate at all** — the server rendered correct HTML, every
asset returned 200, and the page stayed inert.

The dev branch immediately above this code already used `bootstrapModules`, for exactly this
reason. Only the production branch was wrong.

### What it does now

`start()` records whether `assets['main.js']` was resolved from a Vite manifest
(`mainEntryIsModule`), and the SSR render passes `bootstrapModules` when it was.

This is deliberately **not** unconditional. A legacy webpack bundle is a classic script and a
module tag would break it, so the decision follows the manifest the entry actually came from
rather than a global setting.

### Why it survived

Dev never takes this path — `config.server.vite` routes to `bootstrapScriptContent` with the
React-refresh preamble. And no consuming application had completed a production build, because
the release pipeline itself was still being finished. The first app to get that far hit this
immediately.

## 2. `LocalFileStore` rewrote release object keys

**`shapes/filestores/LocalFileStore.ts` — [#52](https://github.com/linked-fw/server/pull/52)**

`resolveTarget`'s preserved character class was `[A-Za-z0-9._/]` — no `-` — so a run of dashes
collapsed to one:

```
asked for:  shapeCodeGenerator--2JmNvrO.js
stored as:  shapeCodeGenerator-2JmNvrO.js
```

Rollup's default base64 hash alphabet includes `-`, so an entry whose hash begins with one meets
the separator as `--`. The stored key is then neither what the caller asked for nor what the
bundle's own URLs point at.

`publish-app` requires a release store to keep keys verbatim and caught it — but only after 125 of
158 objects had uploaded, leaving an incomplete release.

### What it does now

`-` joins the preserved set. The method's own doc comment already stated the intent — not to
corrupt "a key a program chose on purpose, such as a Vite content hash: `main-hwqwrAvA.css`" — so
this makes the character class match what it says. Everything else is unchanged: `My File (2).TXT`
still becomes `My-File-2-.TXT`.

A regression test in `src/tests/local-file-store.test.ts` covers the doubled dash specifically, and
was confirmed to fail without the change.

## The contract both establish

**A release object must be addressable by exactly the key it was given.** The bundle's own chunk
URLs are baked in at build time and nothing rewrites them at request time, so a store that alters a
key — or a server that renders the entry in a form the browser rejects — breaks the release with no
useful error.

Anything implementing `IFileStore` for release assets inherits that requirement.

## Known limitation, not fixed here

`LocalFileStore.accessURL` is bare `SITE_ROOT`, while the store writes to `data/uploads/<key>` and
`LinkedServer` serves that tree at `/uploads` — the `/uploads` segment is appended inside
`publicURL` instead. `build-app` bakes the bundle's base URL from `accessURL`, so publishing to the
default store produces chunk URLs missing that segment, and every chunk 404s.

An application can work around it by registering a dedicated `appAssets` store whose `accessURL`
carries the segment. Moving it into `accessURL` here would be the real fix, but it changes that
field for every existing consumer and warrants its own assessment.
