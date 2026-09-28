# @\_linked/server

## 2.14.0

### Minor Changes

- [#100](https://github.com/linked-fw/server/pull/100) [`91e60bd`](https://github.com/linked-fw/server/commit/91e60bde196aaa849661650a937fc89ef47c728b) Thanks [@flyon](https://github.com/flyon)! - Require `@_linked/core@^2.22.8` (was `^2.20.0`), and pin it in the lockfile.

  The declared range was wide enough that the resolved core depended on whatever the
  consumer — or this repo's own CI, via `package-lock.json` — happened to install. Core
  decides how a shape's IRI is minted, so a stale core made this package emit legacy
  `data.lincd.org` IRIs instead of the arch-02 `linked.cm` scheme. Which IRIs a published
  package produces should not be a function of the installer's dependency tree.

  Minor rather than patch: this raises the minimum core a consumer must resolve, so it
  changes what gets installed rather than only what this package does internally.

## 2.13.7

### Patch Changes

- [#98](https://github.com/linked-fw/server/pull/98) [`fe41a81`](https://github.com/linked-fw/server/commit/fe41a81cb84252890258566fcd668e8ef7e534b1) Thanks [@flyon](https://github.com/flyon)! - The ontology no longer registers by importing itself.

  It carried `import * as _this from './<prefix>.js'` and passed that namespace to
  `linkedOntology()`. Under `tsc` the self-reference survives; under a bundler it does
  not — Rollup treats it as a circular import and elides it, so the binding is
  `undefined` and a consuming app dies at boot with `_this is not defined`.

  Registration now lives in a `<prefix>.register.ts` sibling, imported from the package
  entry. Nothing changes for consumers: importing this package still registers the
  ontology.

## 2.13.6

### Patch Changes

- [#83](https://github.com/linked-fw/server/pull/83) [`5b58619`](https://github.com/linked-fw/server/commit/5b586190b45d52ac8ab70f90e414a7d52fc4d3a9) Thanks [@flyon](https://github.com/flyon)! - Document this package's server-only surface — see
  `docs/architecture/01-server-only-surface.md`.

## 2.13.5

### Patch Changes

- [#92](https://github.com/linked-fw/server/pull/92) [`c17a450`](https://github.com/linked-fw/server/commit/c17a4501f55b824ad3f22ab24fc989f8145f11e7) Thanks [@flyon](https://github.com/flyon)! - Cover `GET /resized/*` with an SVG source.

  The route had no test at all. These assert on the BYTES and the KEY rather than
  the status code, because the half that matters is silent: writing PNG bytes under
  a `.svg` key still returns 200, and only misbehaves on the next request, when the
  cache-hit path types the response `image/svg+xml` from that extension.

  Both branches are covered — the `src`-parameter branch and the uploads branch —
  because the bug was in both, for two different reasons. A third case pins a JPEG
  source as staying a JPEG, so the rasterization cannot quietly become
  unconditional.

  Verified against the reverted fix: both SVG cases fail, the JPEG case passes.

## 2.13.4

### Patch Changes

- [#93](https://github.com/linked-fw/server/pull/93) [`df86a49`](https://github.com/linked-fw/server/commit/df86a490d3335ab3d36645a8c6ae8f3f713d71c2) Thanks [@flyon](https://github.com/flyon)! - `linked.serverOnly` now names what is actually server-only.

  It declared wildcards:

  ```jsonc
  "serverOnly": [".", "./shapes/*", "./server/*", "./utils/*"]
  ```

  Of the thirteen modules under `shapes/` and `utils/`, **two** reach a node
  builtin. The rest are client-safe and were being reported as server-only to
  every consumer — including `BackendAPIStore`, the client-side store that is
  meant to be imported by a frontend. `./server/*` matched nothing at all.

  Consumers that enforce a client/server boundary from these declarations were
  therefore flagging correct code, and the usual repair — an allowlist entry, or
  relocating the module — made things worse rather than better.

  The declaration now lists the six subpaths that genuinely are server-only. No
  code moved and no module changed.

## 2.13.3

### Patch Changes

- [#85](https://github.com/linked-fw/server/pull/85) [`f4c3429`](https://github.com/linked-fw/server/commit/f4c34292997f5fb1de68972cac126e5189585f16) Thanks [@flyon](https://github.com/flyon)! - `/resized/*` now serves SVG sources as PNG instead of failing.

  Sharp can **read** SVG but has no SVG encoder, so every resize of an SVG threw:
  the store-backed branch called `.toFormat('svg', …)`, and the uploads branch called
  `.toBuffer()` with no explicit format, which defaults to the input's. Both now
  rasterize to PNG.

  The cache key follows the output rather than the source, in both branches. Writing
  PNG bytes under a `.svg` key would also have served them as `image/svg+xml`, since
  the cache-hit path types the response from that extension.

  Also treats a zero-length buffer as a missing image rather than handing an empty
  buffer to sharp.

  Found by @abdipramana in #32, against an earlier version of this route. That PR
  also carried an `askQuery` change which has since landed on main by another route,
  and a fetch-based image read that no longer exists — the route now reads bytes
  straight from the store. Only the SVG behaviour still applied, and it is
  reimplemented here against the current structure rather than merged.

## 2.13.2

### Patch Changes

- [#89](https://github.com/linked-fw/server/pull/89) [`1f53442`](https://github.com/linked-fw/server/commit/1f53442e67cfb0abb263b0c430406b3846dc1bbc) Thanks [@flyon](https://github.com/flyon)! - `RouteConfig` compiles under React 19.

  React 19 removed the global `JSX` namespace, so `RouteConfig`'s `component` and
  `render` fields referenced a type that no longer exists and the package failed
  to build for any consumer on React 19. They now use `React.JSX.Element`, which
  is the same type under its current name.

## 2.13.1

### Patch Changes

- [#87](https://github.com/linked-fw/server/pull/87) [`063464c`](https://github.com/linked-fw/server/commit/063464ccfe9df2ae3498479483b33f12e926c91f) Thanks [@flyon](https://github.com/flyon)! - Ontology terms are no longer individual module exports.

  `lincd-server.ts` exported all 11 of its terms as module-scope bindings, and
  several of those names are also shape class names in this package —
  `LincdWebApp`, `LincdAPI`, `BackendAPIStore` and others. Two bindings of the
  same name in one bundle scope make the bundler rename one of them:

  ```js
  Ju = ns("BackendAPIStore"); // the term keeps the binding
  n(nt, "BackendAPIStore2"); // the class is renamed
  ```

  When the loser is a shape class, `constructor.name` is its IRI and the name
  `Server.call` routes on, so a production client asks the backend for a shape it
  has never heard of and the call answers 501.

  Terms are now reached only through the `lincdServer` namespace object:

  ```ts
  import { lincdServer } from "@_linked/server/ontologies/lincd-server";
  lincdServer.LincdWebApp; // instead of a bare `LincdWebApp` import
  ```

  Nothing imported a term individually, so no call site changes.

## 2.13.0

### Minor Changes

- [#84](https://github.com/linked-fw/server/pull/84) [`7c743e3`](https://github.com/linked-fw/server/commit/7c743e30665889b99e866cc5aff87e45c8c16b1a) Thanks [@flyon](https://github.com/flyon)! - `BackendAPIStore` is no longer a Shape; it addresses the backend by package name.

  It used to call `Server.call(this, …)`, whose transport derives the target from
  `shape instanceof Shape && shape.id` (which instance) and `shapeClass.shape.id` (which class).
  That was the only reason this class was a Shape — and the reason the server had to rebuild it
  with `new (providerShapeClass)({id})` on every request, instantiating a Shape purely to discard
  it.

  None of that carried meaning. The provider took the store as its first argument and never read
  it, and query routing is decided by the QUERY's shape via `LinkedStorage`, not by the store. So
  the instance identity was pure addressing.

  It now uses `Server.call`'s existing package-name overload, which sends `{args}` to
  `/call/<packageName>/<method>` with no shape fields, and is answered by this package's generic
  backend provider without any shape resolution. The five query methods moved from
  `BackendAPIStoreProvider` onto `LincdServerBackendProvider`, losing the unused first argument;
  `BackendAPIStoreProvider` is removed.

  **Breaking** for anyone importing `BackendAPIStoreProvider`, or relying on `BackendAPIStore`
  being a Shape (`instanceof Shape`, `.shape`, `targetClass`). The constructor signature is
  unchanged and `IDataset` is implemented in full, so ordinary use through
  `linked.{frontend,backend}.datasets.json` is unaffected.

  This removes the last of the four classes blocking core's deferred Shape-instantiation guard.

## 2.12.4

### Patch Changes

- [#81](https://github.com/linked-fw/server/pull/81) [`ff6d03a`](https://github.com/linked-fw/server/commit/ff6d03ae1fb0a1e74447f1802dd273cf7b229630) Thanks [@flyon](https://github.com/flyon)! - Declare this package's server-only surface.

  ```jsonc
  "linked": { "serverOnly": [".", "./shapes/*", "./server/*", "./utils/*"] }
  ```

  A consuming application's client/server boundary check can now derive that this
  package must not appear in a frontend bundle, instead of hardcoding its name.
  That matters because this package is meant to be replaceable — a check that
  knows it by name only holds for one arrangement of the framework, and a
  replacement would inherit none of the protection.

  Purely declarative: no code, no exports and no resolution behaviour changes.

## 2.12.3

### Patch Changes

- [#77](https://github.com/linked-fw/server/pull/77) [`9901606`](https://github.com/linked-fw/server/commit/990160657aebedc2a4be31357310acdccc9ba7e1) Thanks [@flyon](https://github.com/flyon)! - Document the two fixes that let a Vite-built release be served — see
  `docs/reports/001-vite-release-serving.md`.

## 2.12.2

### Patch Changes

- [#78](https://github.com/linked-fw/server/pull/78) [`1d8e5ac`](https://github.com/linked-fw/server/commit/1d8e5ac2623810a2b4e81c8e355a0b712e9976f3) Thanks [@flyon](https://github.com/flyon)! - Load the application's own backend in the compiled runtime.

  `indexBackendProviders` imports `<app>/backend` by package name. A
  self-reference resolves only from inside the package that declares it, and this
  code runs from `node_modules/@_linked/server` — so Node reported
  `Cannot find package '<app>'` and **every one of the application's Providers
  silently failed to register**, leaving each `Server.call` on one of its shapes
  to 501.

  Development was unaffected: the Vite branch already special-cased the app's own
  backend. The compiled runtime now does the same, resolving `lib/backend.js` by
  path and falling back to `src/backend.ts`.

## 2.12.1

### Patch Changes

- [#75](https://github.com/linked-fw/server/pull/75) [`b285519`](https://github.com/linked-fw/server/commit/b285519430e2e7d1e0daef655c91066af6bd72fd) Thanks [@flyon](https://github.com/flyon)! - Compile the whole `src` folder, and let a bare import resolve under Node10.

  The build only emitted what an entry transitively reached, so any module
  nothing imported was never built — and never type-checked, so it rotted
  quietly. `include` now covers `src/**/*` with tests excluded explicitly.

  `typesVersions` maps every specifier through `lib/esm/*`, so a `types` value
  that already carried that prefix had it applied twice and no consumer on
  classic Node10 resolution could `import` the package by its bare name.

## 2.12.0

### Minor Changes

- [#73](https://github.com/linked-fw/server/pull/73) [`48fb780`](https://github.com/linked-fw/server/commit/48fb78023400bf54b63532639a4c4bf2c3fd5e44) Thanks [@flyon](https://github.com/flyon)! - `/resized/*` reads its source through the file store instead of fetching it, and the route is documented.

  Once `src` had to name an image the store already holds, fetching its public URL
  was a round-trip to ask a web server for a file this process can open — over the
  loopback interface, for a `LocalFileStore`. The bytes now come from
  `LinkedFileStorage.getFile`.

  **The route makes no outbound HTTP request at all.** That retires the machinery
  that existed to make one safe: `fetchStoredImage`, the 10s timeout, the 25MB
  streaming cap and `redirect: 'error'` are all gone. The origin and existence
  checks stay, because they decide _which_ stored file a caller may address.

  `?src=<full URL>` still works exactly as before — the URL is resolved to a key
  and read from the store — so this is a minor, not the major the backlog item
  assumed it would need.

  Also: `resizedImagesPurpose` is registered at the point of use rather than as an
  import side effect, so clearing the registry mid-process (as
  `LinkedFileStorage.resetForTests()` does) can no longer leave `getStore`
  throwing inside a request handler.

  The readme gains a **Resizing images** section: both request forms, what is
  refused and why, and how to point the derivative cache at a different store —
  with the trade-off spelled out, since a local disk cache is per-instance and
  dies with the container while an object-store cache is shared and survives
  deploys.

## 2.11.0

### Minor Changes

- [#71](https://github.com/linked-fw/server/pull/71) [`4d3eb38`](https://github.com/linked-fw/server/commit/4d3eb3832247fc66c6f60cfea35a715e7b7dab2a) Thanks [@flyon](https://github.com/flyon)! - `/resized/*` reads and writes through `LinkedFileStorage` on both branches, and the derivative cache has its own purpose.

  The local branch hardcoded `<cwd>/data/uploads` for both the original and the
  cached derivative. That only ever worked for a `LocalFileStore`: an app with its
  uploads in S3 had nothing on local disk, so **every request to this branch
  404'd**. It now reads the original from the `uploads` purpose and writes the
  derivative through the store, so it works wherever the app keeps its files.

  Three bugs go with it:

  - The cache directory was never created. The `mkdirSync` that should have done
    it was commented out, and the `toFile` failure was swallowed with a
    `console.warn`, so on a deployment where `data/uploads/resized` did not exist
    every resize silently failed to cache and then 404'd with nothing to say why.
    No hand-rolled directory creation is needed now — `LocalFileStore.saveFile`
    makes its own parents.
  - On a resize error the handler sent a 500 and then fell through to
    `res.sendFile`, a second send on the same response.
  - A cache write failure is now logged rather than fatal: the resize succeeded,
    so the caller still gets its image and only the caching is lost.

  **New purpose: `resizedImagesPurpose`.** A resize cache is not the same thing as
  user uploads — uploads are originals and must be kept, derivatives are
  reproducible and can be dropped or served from somewhere cheaper. Naming it
  separately lets an app decide:

  ```ts
  import { resizedImagesPurpose } from "@_linked/server/utils/resizedImagesPurpose";

  // originals in S3, derivatives cached on the local disk
  LinkedFileStorage.setStore(resizedImagesPurpose, new LocalFileStore("cache"));
  ```

  Left alone it falls back to the default store, which is what the route did
  before, so no app has to care unless it wants to.

  The response contract is unchanged: this branch still answers `200` with the
  image bytes rather than redirecting.

## 2.10.1

### Patch Changes

- [#69](https://github.com/linked-fw/server/pull/69) [`8b37a9a`](https://github.com/linked-fw/server/commit/8b37a9a9691f67e4131a16d45c3a104d0b09b389) Thanks [@flyon](https://github.com/flyon)! - Fix `/resized/*` for `LocalFileStore`: resolve the source URL back to the right key, and write the resized file beside it.

  The source guard added in the previous release derived one storage key from the
  source URL. That is correct for `S3FileStore`, which serves a key directly under
  its `accessURL` — but `LocalFileStore` serves `accessURL + '/uploads/' + key`,
  so a file stored as `photo.jpg` is served at `/uploads/photo.jpg` and the
  derivation produced `uploads/photo.jpg`. `fileExists` then returned false and
  **every remote-branch resize 404'd on a LocalFileStore deployment**. The tests
  covered only a store shaped like S3, which is why this shipped.

  `IFileStore` has no URL-to-key inverse, so `resolveResizeSource` now returns both
  candidate shapes and the route takes the first the store actually holds. It stays
  fail-closed: a path matching neither is still refused without any request, and it
  costs one extra `fileExists` in the local case.

  The same mismatch was on the write side, and predates the guard: the destination
  key was derived from the URL path, so a `LocalFileStore` wrote resized files to
  `data/uploads/uploads/resized/` — a nested duplicate of the uploads folder. It is
  now derived from the matched key, giving `resized/photo_w60.jpg` locally and the
  unchanged `uploads/resized/photo_w60.jpg` for S3.

  Covered by tests against a real `LocalFileStore` rather than an in-memory stand-in,
  which is the gap that let the first version through.

## 2.10.0

### Minor Changes

- [#67](https://github.com/linked-fw/server/pull/67) [`d541028`](https://github.com/linked-fw/server/commit/d541028464414e37b364501ea90b6f04e7f39c96) Thanks [@flyon](https://github.com/flyon)! - `/resized/*` only resizes images the app already stores, and both branches agree on the cache key.

  **The SSRF.** `?src=` was handed straight to `fetch`, with the check that should
  have guarded it sitting commented out above a `TODO`. Any unauthenticated caller
  could aim the server at cloud metadata, `localhost`, or a private range — and
  the route is registered _before_ the `apiOnly` guard, so this was live in
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

  **The cache key.** The underscore in a resized name was emitted by the _width_
  segment, so a height-only request produced `logo_h30.png` on the local branch
  but `logoh30.png` on the remote one — two halves of one route disagreeing on the
  key for the same request. The separator is now emitted once, before either
  dimension, so both read `logo_h30.png`. Height-only entries cached under the old
  name are orphaned: they still resolve if a URL was handed out, but the next
  request generates the new key. Width-only and width+height keys are unchanged,
  which is the overwhelming majority.

  Tests 126 → 137.

## 2.9.0

### Minor Changes

- [#65](https://github.com/linked-fw/server/pull/65) [`85d61d1`](https://github.com/linked-fw/server/commit/85d61d107af292d2b6e02d73bb41251248239d2c) Thanks [@flyon](https://github.com/flyon)! - Upgrade `sharp` to ^0.35.4 and drop the unused `adm-zip` dependency.

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

  Five declared dependencies are removed, each referenced nowhere in the package:
  `adm-zip`, `archiver`, `zip-a-folder`, `node-hook` and `is-object`. Only
  `adm-zip` carried advisories -- three of them, so that is three fewer for every
  consumer. The other four are weight rather than risk: 38 fewer packages in a
  consumer's tree.

  Note for whoever picks it up next: `resizeImage` still fetches an arbitrary
  `req.query.src` server-side. The `// TODO: restrict resizing to images that are
stored by LinkedFileStorage` above it is an unfixed SSRF and is arguably a
  bigger problem than the libvips CVEs this change closes. Deliberately left
  alone here rather than mixed into a dependency bump.

## 2.8.0

### Minor Changes

- [#63](https://github.com/linked-fw/server/pull/63) [`10a61bb`](https://github.com/linked-fw/server/commit/10a61bb7bcd2d85c24abc108ce86ac7bdfa51472) Thanks [@flyon](https://github.com/flyon)! - `LocalFileStore` suffixes only on a real collision, and `listFiles` returns keys you can use.

  **`preventDuplicates` now means what its name says.** The random `_ab12cd` suffix
  was applied to _every_ save, without ever checking whether the name was taken —
  so a caller never got back the key it asked for. A content-hashed bundle handed
  over as `main-hwqwrAvA.css` landed as `main-hwqwrAvA_x9k2ml.css`, and the name
  baked into the HTML no longer resolved. `@_linked/cli` publishes app assets with
  a bare two-argument `saveFile`, so it hit exactly this.

  The store now checks first and suffixes only when the name is occupied,
  re-checking the suffixed name in turn. **The never-clobber guarantee is
  unchanged** — a taken name still gets a fresh key, and an explicit
  `preventDuplicates: false` still overwrites in place. What changes is that a free
  name is left alone, which is what `S3FileStore` has always done: the two
  implementations of `IFileStore` now read the flag the same way.

  Minor rather than patch because stored keys change shape: a first save that used
  to produce `report_312acb.pdf` now produces `report.pdf`. Anything that recorded
  a returned `storedPath` keeps working; anything that _assumed_ every key carries
  a suffix should re-read `storedPath`, which has always been the supported way to
  learn the key.

  **`listFiles` is usable for the first time.** It returned keys joined onto
  `basePath` (`data/uploads/x.txt`) while every other method on the store resolves
  its argument _against_ `basePath` — so feeding a result straight back into
  `getFile` looked for `data/uploads/data/uploads/x.txt` and found nothing. Keys
  are now relative to the base folder, matching `S3FileStore`, which strips its
  bucket prefix before returning.

  Two more bugs went with it: the recursive branch called `listFiles(prefix)`,
  which re-read `basePath` and found the same directory again — unbounded
  recursion as soon as the store held a single folder — and the `prefix` argument
  was accepted and then ignored entirely. Subdirectories are now walked properly
  and `prefix` filters the returned keys.

## 2.7.5

### Patch Changes

- [#61](https://github.com/linked-fw/server/pull/61) [`fd8a5ec`](https://github.com/linked-fw/server/commit/fd8a5ec14f14a91e03ced486582a3ffd698e0967) Thanks [@flyon](https://github.com/flyon)! - `LocalFileStore` no longer extends `Shape`.

  It used nothing from `Shape`: no `this.id`, no `this.uri`, no `nodeShape`, no
  Shape statics, no property decorators, and no caller anywhere treats it as a
  Shape. The only inherited behaviour was `super({id})` writing an id nothing read.

  Stores and datasets stopped being Shapes deliberately in core `0e8c86e`
  ("datasets are not shapes"), and `Shape`'s instantiation guard is currently
  deferred naming this class as the reason it had to be. This removes one of the
  last obstacles to re-enabling that guard.

  No API change: the constructor still accepts both the `string` and `{id}` forms,
  and the class still implements `IFileStore` in full.

## 2.7.4

### Patch Changes

- [#59](https://github.com/linked-fw/server/pull/59) [`9ca2bee`](https://github.com/linked-fw/server/commit/9ca2bee974af59bb46318b236aa3e410772406f0) Thanks [@flyon](https://github.com/flyon)! - Use one Vite-dev test for the entry bootstrap and the route assets. A production Vite build served from a config that still carries `server.vite` was given the dev preamble (importing `/@vite/client`, absent in production) instead of the entry script, while the route preloads correctly took the production path — so the page never hydrated. `isViteDevServer` in `utils/bootstrapEntry` is now the single decision, used by the bootstrap, the route preloads and the `__viteDev` asset marker.

## 2.7.3

### Patch Changes

- [#57](https://github.com/linked-fw/server/pull/57) [`b47d50e`](https://github.com/linked-fw/server/commit/b47d50e818db8d0b7cbfba582213ea8cf2296a30) Thanks [@flyon](https://github.com/flyon)! - Match route `preloadChunks` against the Vite manifest case-insensitively, and warn when one resolves to nothing.

  Apps carrying webpack-era lowercase chunk names (`['home', 'signin']`) matched nothing in a Vite manifest keyed by source path (`src/pages/Home.tsx`), so no preload tags were emitted at all — silently. Exact matching by source path and by path tail still wins; the case-insensitive basename match is only a fallback, anchored on the path separator so `home` cannot be answered by `MyHome.tsx`. An unresolved chunk name is now logged once per name, not once per request.

## 2.7.2

### Patch Changes

- [#52](https://github.com/linked-fw/server/pull/52) [`e535296`](https://github.com/linked-fw/server/commit/e535296f8bef4fdceef1c04918469d1dd317088d) Thanks [@flyon](https://github.com/flyon)! - `LocalFileStore` keeps dashes in a key instead of collapsing runs of them.

  The sanitiser's preserved character class left `-` out, so a run of dashes
  became one. Rollup's default base64 hash alphabet includes `-`, so an entry
  whose hash starts with one meets the separator as `--`:
  `shapeCodeGenerator--2JmNvrO.js` was stored as `shapeCodeGenerator-2JmNvrO.js`.
  That is a different key from the one baked into the bundle, so the asset 404s —
  and `publish-app`, which requires a release store to keep keys verbatim,
  rejected the whole release.

## 2.7.1

### Patch Changes

- [#51](https://github.com/linked-fw/server/pull/51) [`c33a0d8`](https://github.com/linked-fw/server/commit/c33a0d81fccee6ff0ae354400c318443377b0673) Thanks [@flyon](https://github.com/flyon)! - Bootstrap a Vite-built entry as an ES module.

  React renders `bootstrapScripts` as a plain `<script src async>`. Vite always
  emits the client entry as an ES module, so every production build died on the
  first line with "Cannot use import statement outside a module" and the app
  never hydrated. When the entry was resolved from a Vite manifest it is now
  passed as `bootstrapModules` instead. A legacy webpack bundle is still a
  classic script and keeps `bootstrapScripts`.

## 2.7.0

### Minor Changes

- [#53](https://github.com/linked-fw/server/pull/53) [`4c91f60`](https://github.com/linked-fw/server/commit/4c91f606cde322c470c7205ce6e9845e449af45a) Thanks [@flyon](https://github.com/flyon)! - Serve a route's preloaded chunks from the release base, not from the app's own
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

## 2.6.0

### Minor Changes

- [#49](https://github.com/linked-fw/server/pull/49) [`8c07382`](https://github.com/linked-fw/server/commit/8c07382a16148df778a2a1abb0d50ddd52f0f816) Thanks [@flyon](https://github.com/flyon)! - Derive the asset base URL from the release manifest.

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

## 2.5.1

### Patch Changes

- [#39](https://github.com/linked-fw/server/pull/39) [`dfdc27b`](https://github.com/linked-fw/server/commit/dfdc27b8a09f127d553c08a0e86ec67da784183c) Thanks [@flyon](https://github.com/flyon)! - Declare npm as the package manager for this repo and mark `package-lock.json` as a generated file.

## 2.5.0

### Minor Changes

- [#44](https://github.com/linked-fw/server/pull/44) [`616f019`](https://github.com/linked-fw/server/commit/616f0195e0c263ccb6240d65c9c94435319649a0) Thanks [@flyon](https://github.com/flyon)! - Fix `LocalFileStore.saveFile`: preserve the key, honour `basePath`, and report where the file landed.

  `saveFile` went through `getUploadTarget`, which lowercases the name and always resolves against the server's upload
  folder. Two consequences: a key whose case matters (a Vite content hash such as `main-hwqwrAvA.css`) was corrupted, and
  a store built with a custom `basePath` wrote to the upload folder while `getFile`, `fileExists`, `deleteFile` and
  `statFile` all read from `basePath` — so it could never read back what it wrote.

  `saveFile` now resolves the target against the store's own `basePath`, like every other method, and keeps the name's
  case. Unsafe characters are still replaced and a missing extension is still added from `mimeType`; lowercasing stays
  where it belongs, in `@_linked/server-utils`' upload handling, which already sanitises a browser-supplied filename
  before any store sees it.

  New `saveFileWithPath()` returns `{storedPath, publicURL}`, so a caller can hand `storedPath` straight to
  `statFile`/`getFile`. With `preventDuplicates: false` that path equals the path given, verbatim.

  Minor rather than patch because behaviour changes for existing callers in two ways:

  - a name containing uppercase characters is now stored with its case intact instead of lowercased. Callers that pass an
    already-lowercased name (which is what the HTTP upload path does) are unaffected.
  - a store constructed with a custom `basePath` now writes into that folder instead of `./data/uploads`.

  Unchanged: the default `basePath`, the suffixing default when `preventDuplicates` is unspecified, the returned URL, and
  the two-argument `LinkedFileStorage.saveFile(path, buffer)` path.

## 2.4.0

### Minor Changes

- [#38](https://github.com/linked-fw/server/pull/38) [`bf1e83c`](https://github.com/linked-fw/server/commit/bf1e83cdfc949baec88a645c2750479bc33f1637) Thanks [@flyon](https://github.com/flyon)! - `LocalFileStore` accepts the new `SaveFileOptions` third argument of `saveFile`
  (still accepting a positional mime-type string) and gains `statFile()`, which
  returns the size and a sha256 of a stored file, or `null` when it does not
  exist, for verify-after-upload. A local file has no headers, so `cacheControl`
  and `metadata` are accepted and ignored.

  Core reports an unspecified `preventDuplicates` as `undefined` and applies no
  default of its own, so this store keeps applying its own: a caller that says
  nothing still gets the random file-name suffix, and only an explicit
  `preventDuplicates: false` overwrites an existing name.

## 2.3.1

### Patch Changes

- [#40](https://github.com/linked-fw/server/pull/40) [`804851d`](https://github.com/linked-fw/server/commit/804851d16f005b56893c73561aaf72ad64a78434) Thanks [@flyon](https://github.com/flyon)! - Point `repository.url` at the linked-fw organisation, so npm provenance verification matches the repository that builds the package.

## 2.3.0

### Minor Changes

- [#36](https://github.com/linked-cm/server/pull/36) [`e0c0627`](https://github.com/linked-cm/server/commit/e0c06276e578396efe4be413f367b391b2132451) Thanks [@flyon](https://github.com/flyon)! - Make server call failures explicit. Update code that relied on failed calls resolving quietly.

  - **No provider now answers 501.** A `/call/...` request that no provider handles gets `501 {"error": "No provider for <pkg>/<method>"}`. Before, it got `200` with an empty body (shape methods) or `200 null` (backend methods). This covers both a missing provider and a provider without the called method.
  - **Provider errors answer 500 (since 2.2.0).** A provider method that throws answers `500 {"error": ...}` instead of `200 null`. The 2.2.0 changeset did not mention this.
  - **Backend-to-backend `Server.call` rejects.** When `Server.call` runs on the backend, where it calls `LinkedServer` directly, a provider method that throws rejects the promise (since 2.2.0). An unmatched call throws a `ServerCallError` with status 501. `@_linked/server-utils` resolves that as `undefined` unless the caller passes `rejectOnError: true`.
  - **`BackendAPIStore` rejects only on HTTP errors.** It calls with `rejectOnError: true`, so a failed query rejects with a `ServerCallError` carrying the HTTP `status` and the server's message. A successful call resolves whatever the provider returned, `undefined` included. Before, every `undefined` result was treated as a failure.
  - **Dependency.** Requires `@_linked/server-utils` ^1.2.0.

## 2.2.0

### Minor Changes

- [#34](https://github.com/linked-cm/server/pull/34) [`f7ae758`](https://github.com/linked-cm/server/commit/f7ae758ba165df8c1f4a4ca46b189f3e17cc1e51) Thanks [@flyon](https://github.com/flyon)! - Honour `server.apiOnly` (set by `linked start --api-only`): LinkedServer skips the SPA catch-all, so a backend without a web frontend serves its API routes and answers page requests with a plain 404 instead of failing to render a missing `src/App.tsx`.

  `BackendAPIStore` implements `askQuery`, required by `IDataset` since `@_linked/core` 2.18.1. It is forwarded to the backend like the other query kinds (as DSL-JSON through `Server.call`, rehydrated and answered by `BackendAPIStoreProvider` through `LinkedStorage.askQuery`), so it type-checks as an `IDataset` without a cast. `@_linked/core` is bumped to `^2.18.1`.

  Linked packages whose `exports` have no `./backend` entry no longer log a `Missing "./backend" specifier` error at boot. Real backend load errors are still reported.

  A backend or shape provider method that throws during a `/call/...` request now answers with HTTP 500 and a JSON `{error}` body (the same shape as other server errors) instead of `200 null`; direct backend-to-backend calls get a rejected promise. `BackendAPIStore` rejects when `Server.call` returns no response (a failed HTTP call), so a failed query no longer reads as an empty result.

## 2.1.7

### Patch Changes

- [#30](https://github.com/linked-cm/server/pull/30) [`87a524b`](https://github.com/linked-cm/server/commit/87a524bde754865b89db509a96445c4e7e0a8b55) Thanks [@flyon](https://github.com/flyon)! - Track the current `@_linked/core` (^2.17.0).

  The declared range was `^2.2.1` while the lockfile pinned 2.11.1, so CI built
  against a core three minor versions behind the one consumers actually run. That
  divergence is invisible locally — the monorepo resolves core to 2.17.0 — and it
  surfaced as a build failure only after a change referenced a module that exists
  in 2.17.0 but not in 2.11.1.

## 2.1.6

### Patch Changes

- [#28](https://github.com/linked-cm/server/pull/28) [`093e096`](https://github.com/linked-cm/server/commit/093e096ee1ffd70c516289b850d0f4081088df4c) Thanks [@flyon](https://github.com/flyon)! - Install the SPA catch-all after `setupAfterControllers`, and re-pin it after HMR.

  The client shell is served from a catch-all `GET *`, which is only a fallback by
  accident of registration order. Two supported paths register GET routes once it
  already exists: `setupAfterControllers` (a documented provider hook, which ran
  _after_ the catch-all was installed) and `onSourceChange`, where
  `disposeRoutes()` splices a provider's layers out and `registerRoute()` can only
  append them back. A route that ends up behind the catch-all is answered with the
  HTML shell at status 200, so it reads as an auth/config problem rather than a
  routing one.

  The catch-all now goes on last, in its own `installSpaFallback()` step after
  `setupAfterControllers`, and `onSourceChange` re-pins it once providers have
  re-registered. Ordering is asserted at registration time from the two places
  that create the situation, so nothing hooks express's dispatch path. Trailing
  error-handling middleware (arity-4) is deliberately kept behind the fallback, so
  errors thrown while rendering the shell still reach the app's error handler.

  Adds the package's first test harness (jest + ts-jest) with coverage for the
  ordering, the dispose/re-register cycle, error-handler placement, idempotency,
  and a negative control asserting the shell wins when re-pinning is skipped.

## 2.1.5

### Patch Changes

- [#26](https://github.com/linked-cm/server/pull/26) [`b3ea735`](https://github.com/linked-cm/server/commit/b3ea7357b757be0bdbd17643444dfeba1fba16da) Thanks [@flyon](https://github.com/flyon)! - Build the in-memory shape index against either core property-list shape.

  `indexShapesIntoMemory` read `localShape.properties`. Newer `@_linked/core`
  converted shape metadata to plain objects exposing `propertyShapes` and dropped
  the `NodeShape.properties` getter, so that read returned undefined and threw on
  `.map`. The throw happened while evaluating the object literal, before the
  `shapeIndex[...] = ...` assignment, on the first shape class carrying a
  `.shape` — so the loop aborted on its first iteration and the index was left
  completely empty rather than partial. Everything reading it (LincdAPI
  `get_all_shapes` / `get_shape_details`, and the shape-catalog fallback and
  shape-sync in create-now-js) silently saw nothing.

  Nothing surfaced because the async call was not awaited at either call site
  (`initOnly`, `start`): the failure escaped as an unhandled rejection and boot
  continued as if it had succeeded. Both call sites now await it.

  The property list is read as `.properties ?? .propertyShapes`, so the index
  builds against both the core generation this package declares (which still has
  the getter) and newer core (plain objects).

## 2.1.3

### Patch Changes

- [#20](https://github.com/linked-cm/server/pull/20) [`2bda81c`](https://github.com/linked-cm/server/commit/2bda81c6cbbbb950aa611c6366426698a5eb15b8) Thanks [@flyon](https://github.com/flyon)! - `LinkedServer.callShapeMethod` now degrades gracefully (warns and skips) when a shape URI can't be resolved to a provider, instead of throwing and turning the whole request into a 500.

## 2.1.2

### Patch Changes

- [#17](https://github.com/linked-cm/server/pull/17) [`ef9d285`](https://github.com/linked-cm/server/commit/ef9d2858fcfc766ead96c620f835dc94bf30baeb) Thanks [@flyon](https://github.com/flyon)! - Remove the `development` export condition (pointed at `src`, which isn't shipped to npm). Monorepo dev resolves workspace source via the cli Vite plugin; standalone resolves `import → lib`. No consumer-visible change.

## 2.1.1

### Patch Changes

- [#15](https://github.com/linked-cm/server/pull/15) [`e98441f`](https://github.com/linked-cm/server/commit/e98441fbef10dd3583e7fd04a3e45b5ad73e03cd) Thanks [@flyon](https://github.com/flyon)! - Replace removed `CoreMap` with native `Map` (core dropped CoreMap in `b2de3ad`). Fixes `Cannot find module @_linked/core/collections/CoreMap` from LinkedServer on a clean install.

## 2.1.0

### Minor Changes

- [#13](https://github.com/linked-cm/server/pull/13) [`8932811`](https://github.com/linked-cm/server/commit/89328117fa9500897a5a57b86e07efe5860d81cd) Thanks [@flyon](https://github.com/flyon)! - **ESM-only.** Dropped the CommonJS build; the package now ships ES modules only (`type: module`, no `require` export condition, no `lib/cjs`). All first-party consumers are ESM; CJS projects on Node 22+ can still `require()` it (sync ESM) or use dynamic `import()`. Also fixed the root `types` field (was a non-existent `./index.d.ts`).

### Patch Changes

- [#13](https://github.com/linked-cm/server/pull/13) [`daef98d`](https://github.com/linked-cm/server/commit/daef98d777144285c2f63ed43821902371df2c66) Thanks [@flyon](https://github.com/flyon)! - `BackendAPIStore` now speaks DSL-JSON over the wire, adapting to the `@_linked/core` query-contract flip (datasets receive the live/closed query, not IR).

  - The frontend store serializes each query with `query.toJSON()` before `Server.call` (the live query can't cross the wire), replacing the removed `getQueryObject()` path.
  - `BackendAPIStoreProvider` rehydrates it with `fromJSON(json)` back into a live query before routing through `LinkedStorage` — the backend store lowers it to SPARQL itself.

  No API change for callers; the round-trip is `lower(fromJSON(query.toJSON())) ≡ lower(query)`.

- [#13](https://github.com/linked-cm/server/pull/13) [`28d0f49`](https://github.com/linked-cm/server/commit/28d0f497b332a663af9d40162d017a2a35cbfb31) Thanks [@flyon](https://github.com/flyon)! - Dropped `lincd-sioc: ~1.0` from `package.json` dependencies. Audit
  confirmed no source file in `packages/server/src` imports from sioc;
  the dep was vestigial.

  No API change. Consumers that depended on `@_linked/server` transitively
  pulling sioc into their lockfile will need to add `@_linked/sioc` (the
  new name; see its own release notes) as a direct dep if they actually
  use it.

  Context: see create-now plan-011 report (docs/reports/009-legacy-lincd-eradication.md).

## 2.0.3

### Patch Changes

- [#10](https://github.com/linked-cm/server/pull/10) [`5619ddf`](https://github.com/linked-cm/server/commit/5619ddf9268469eea566e110ce5c3c4fd68b407d) Thanks [@flyon](https://github.com/flyon)! - Switch to explicit per-step build pipeline (mirrors `@_linked/cli`'s and `@_linked/server-utils`'s). The previous `yarn linked build` wrapper was failing silently in CI and shipping incomplete tarballs.

## 2.0.2

### Patch Changes

- [#8](https://github.com/linked-cm/server/pull/8) [`17e6771`](https://github.com/linked-cm/server/commit/17e6771ba1c2eae2daf24b97dcb9e934827f4396) Thanks [@flyon](https://github.com/flyon)! - Rebuild against `@_linked/server-utils@1.0.5`. The lockfile previously pinned `1.0.4` whose published tarball was empty, so server's build couldn't resolve `BackendProvider`/`JSONParser`/`JSONWriter`/`RouteConfig`. Lockfile now points at `1.0.5` which ships its `lib/` correctly.

## 2.0.1

### Patch Changes

- [#6](https://github.com/linked-cm/server/pull/6) [`7eb425b`](https://github.com/linked-cm/server/commit/7eb425b26cc1e234041c6a678b184874ef2be017) Thanks [@flyon](https://github.com/flyon)! - Rebuild + republish. The 2.0.0 tarball shipped without `lib/` because the build silently failed against an empty `@_linked/server-utils@1.0.4` tarball. `@_linked/server-utils@1.0.5` now ships its `lib/` correctly, so this version compiles + packages as intended.

## 2.0.0

### Major Changes

- [#4](https://github.com/linked-cm/server/pull/4) [`d1ad65c`](https://github.com/linked-cm/server/commit/d1ad65ccda75e643a30e911f97584d3a2b6ff3e8) Thanks [@flyon](https://github.com/flyon)! - Track `@_linked/core` storage-API renames and adopt the new BackendAPIStore config-object constructor.

  **Breaking — call-site renames** (paired with the matching changes in `@_linked/core`):

  - `LinkedStorage.setDefaultStore` → `setDefaultDataset`
  - `LinkedStorage.setStoreForShapes` → `setDatasetForShapes`
  - `LinkedStorage.getDefaultStore` → `getDefaultDataset`
  - `LinkedStorage.getStores` → `getDatasets`
  - `SparqlStore` → `SparqlDataset`

  **Breaking — `BackendAPIStore` constructor takes a config object:**

  ```ts
  // before
  new BackendAPIStore("appData");

  // after
  new BackendAPIStore({ name: "appData" });
  ```

  The config field is `name` (renamed from `alias` in the intermediate iteration).

  **Fix — scoped-package `/call` routes.** Backend now correctly routes `/call/@scope/pkg/method` requests, not just `/call/pkg/method`.

  **Fix — relative bundle URLs in dev.** Drops the baked-in `:4000` origin so bundle URLs work whatever `PORT` the dev server binds to.

  **Docs.** Constructor doc-comments refreshed from the older `lincd` naming to `linked`.

### Minor Changes

- [#4](https://github.com/linked-cm/server/pull/4) [`2ae7a72`](https://github.com/linked-cm/server/commit/2ae7a72b6381e1758cded50309762bd11de57bd5) Thanks [@flyon](https://github.com/flyon)! - Update `BackendAPIStore` to implement `IDataset` (renamed from `IQuadStore` in `@_linked/core`).

  No functional change — import path and interface name updated to match the new `@_linked/core` export.

## 1.0.8

### Patch Changes

- [`bb74f32`](https://github.com/linked-cm/server/commit/bb74f320c407db168300c78c8aea005f2dff3d0e) - Initial release under the new publishing setup.
