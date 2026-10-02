# LINCD Server

This package provides a `LincdServer` which can be used to instantiate a LINCD backend environment on node.js.

If you use `npx lincd-cli create-app [name]` it will already set everything up for you to use `LincdServer`.
To see how it's used, open `your-site/backend/server.js`.

If you require any additional features, feel free to make a request at the LINCD Discord server.
If you want to further adjust the functionality of LincdServer yourself, either extend it or clone this repo locally.

---

## Table of contents

- [Environment Variables](#environment-variables)
  - [Where asset URLs come from](#where-asset-urls-come-from)
- [Calling methods on the backend](#calling-methods-on-the-backend)
  - [Shape providers](#shape-providers)
  - [Generic backend providers](#generic-backend-providers)
  - [Gotchas](#gotchas)
  - [Error semantics](#error-semantics)
- [API-only servers (`server.apiOnly`)](#api-only-servers-serverapionly)
- [Provider lifecycle and HMR](#provider-lifecycle-and-hmr)
  - [When to implement `dispose()`](#when-to-implement-dispose)
  - [Route tracking helpers](#route-tracking-helpers)
  - [Examples](#examples)
- [Shapes](#shapes)
  - [LocalFileStore](#localfilestore)
- [TODO](#todo)

---

## Environment Variables

```properties
# The port on which the server will listen
PORT=3000

# A descriptive URI for where the app's data can live
DATA_ROOT=https://app.my-site.com/data

# The site's URL - will also be used for LocalFileStore
SITE_ROOT=http://localhost:3000  # or https://app.my-site.com

# "development" or "production"
NODE_ENV=development

# Optional. Base URL the HTML entry tags (main.js / main.css) are served from.
# Usually no longer needed: see "Where asset URLs come from" below.
STATIC_ACCESS_URL=https://cdn.my-site.com/releases/1.5.0-2a77e89f
```

### Where asset URLs come from

The server renders its own `<script>` and `<link rel="stylesheet">` entry tags, so it has to know the base URL the
client bundle is served from. It resolves that base once at boot, in this order:

1. **Development** (`NODE_ENV=development`) — a relative path, so the tags work on whatever port the dev server bound
   to and Vite keeps serving the assets itself.
2. **`STATIC_ACCESS_URL`** — an explicit deployment decision always wins.
3. **The release manifest** — `linked build-app` (`@_linked/cli` 1.19+) publishes a release under
   `releases/<version>-<revision>/` and writes `public/bundles/linked-release.json` describing it. Its
   `destination.baseURL` is the value the bundle itself was built with as Vite's `base`, so deriving the entry tags
   from it guarantees the tags and the bundle's own chunk URLs point at the same release. **This removes the manual
   step of setting `STATIC_ACCESS_URL` to `<accessURL>/<releasePrefix>` on every release.**
4. **`LinkedFileStorage.accessURL`**, then an empty base — the historical fallback.

An app with no release manifest behaves exactly as before. A manifest that is missing, unparsable, of an unknown
`schemaVersion`, or without a published destination (a Capacitor build records an empty one) is ignored with a
warning and the server falls through to step 4 — a broken manifest never stops a server from booting.

That base covers **every** URL the build produced, not just the entry tags. A route's `preloadChunks` are resolved
per request from the bundle manifest and rendered as `<base>/public/bundles/<file>` — the same composition the entry
tags use, since Vite manifest paths are relative to the bundle directory. A page therefore never mixes a CDN-hosted
`main.js` with route chunks requested from the app server. With an empty base the URLs stay origin-relative
(`/public/bundles/…`), which is where `express.static('./public')` is mounted.

## Calling methods on the backend

When you use LincdServer, you can also implement backend methods that you can access from the frontend.

There is two ways to do this:

### Shape providers

With Shape providers you can connect shapes to a backend method.

Let's say for example you want to send an email to a specific person from the server.
You could do that from a Person shape like so:

```typescript
import { linkedShape } from '../package';
import { Shape } from '@_linked/core/lib/shapes/Shape';
import { Server } from 'lincd-server/lib/utils/Server';

@linkedShape
export class Person extends Shape {
  sendEmail(subject: string, message: string): Promise<boolean> {
    return Server.call(this, 'sendEmail', subject, message);
  }
}
```

Note that `Server.call()` first takes the instance of the shape, then the method name and than any number of arguments
to be passed on.

To implement the backend, create `src/shapes/PersonProvider.ts`:

```typescript
import Person from './Person';
import { ShapeProvider } from 'lincd-server-utils/lib/utils/ShapeProvider';

export class PersonProvider extends ShapeProvider {
  static shape = Person;

  static sendEmail(person: Person, subject: string, message: string): boolean {
    //send email to person
    //mail(person.mailbox,subject,message);
  }
}
```

Here, PersonProvider first of all registers itself as a provider of the `Person` shape with `static shape = Person`.

Then it implements the method (sendEmail()) as a a _static_ method, which receives an instance of the shape it is
connected to as its first argument.

To make sure the provider is _compiled_ but _not bundled_ you need to add it to `tsconfig`.

The recommended way to do that is with a providers index file `src/providers.ts`.
This file will re-export all providers of your package:

```typescript
//src/providers.ts
export * from './shapes/PersonProvider';
```

Finally, add `providers.ts` to your `src/tsconfig.json`:

```json5
//tsconfig.json
{
  //...
  files: ['./src/index.ts', './src/providers.ts'],
}
```

That's all that's required to connect your frontend shapes to backend code.

### Generic backend providers

Sometimes you want to exchange data with the backend without any specific shape being involved.

For such generic backend methods, you can use generic backend providers:

Add a src/backend.ts file and include it in tsconfig.json:

```json5
//tsconfig.json
{
  //...
  files: ['./src/index.ts', './src/backend.ts'],
}
```

In `backend.ts`, export a default class that implements `IBackendProvider`.
In this class you can implement methods, which you can then call from the frontend.

For example:

```typescript
//src/backend.ts
import { IBackendProvider } from 'lincd-server/lib/interfaces/IBackendProvider';

export default class MyPackageBackendProvider implements IBackendProvider {
  login(email: string, password: string) {
    //do login
    return Promise.resolve(user);
  }
}
```

With this example you could call the login method from the frontend like so:

```typescript
import { packageName } from '../package';
import { Server } from 'lincd-server/lib/utils/Server';

Server.call(packageName, 'login', email, password).then((user) => {
  //...
});
```

Note that you can have **only one** generic backend provider per package.

### Gotchas

**The packageName you pass to Server.call() must match with the package that contains the provider.**

If you get a warning on the backend saying

```
Generic provider [providerName] of [packageName] does not have a method called [methodName]
```

then make sure that the `packageName` you pass to `Server.call(packageName)` is imported from _the same package_ as
where the provider lives. Generally, this means you call `Server.call` from a component in the same package as the
Provider (and import packageName from `src/package.ts`). If you want to call a method from another package, then import
packageName from that package, or manually type it.

### Error semantics

The `/call/...` routes answer as follows:

| Situation | Response |
| --- | --- |
| The provider method returns a value | `200` with the JSON result (`null` when the method returns nothing and has not written the response itself) |
| The provider method throws | `500 {"error": "internal server error..."}`. The stack is included in development only. |
| No provider handles the call (no provider for the package or shape, or the provider has no such method) | `501 {"error": "No provider for <pkg>/<method>"}` |

What the caller sees depends on how it calls:

- **`Server.call` from the frontend (over HTTP).** By default a non-2xx response logs a warning and resolves `undefined`. Pass `{ method, rejectOnError: true }` as the method to reject with a `ServerCallError` instead. The error carries `status` and the server's `error` message.

  ```typescript
  Server.call(this, { method: 'sendEmail', rejectOnError: true }, subject, message);
  ```

- **`Server.call` on the backend.** Here it calls the `LinkedServer` directly.
  - A provider method that throws always rejects.
  - An unmatched call resolves `undefined` by default and rejects with a 501 `ServerCallError` when `rejectOnError` is set.
- **`BackendAPIStore`.** It always uses `rejectOnError`, so a failed query rejects with the status and message. A successful call resolves with whatever the provider returned, `undefined` included.

## API-only servers (`server.apiOnly`)

A backend that serves no frontend app (e.g. started with `linked start --api-only`) can set `apiOnly` in its server config:

```typescript
new LinkedServer({
  server: {
    apiOnly: true,
    //...
  },
});
```

With `apiOnly` the server skips page rendering. It installs no SPA catch-all, so a `GET` for a page that no route handles gets express's plain `404` instead of the app shell. The `/call/...` and `/api/...` routes and the routes that providers register work as usual.

## Provider lifecycle and HMR

Every provider — generic (`BackendProvider`) or shape-scoped (`ShapeProvider`) — has a lifecycle the framework drives:

1. **Construction** — `LincdServer.indexPackageBackendProviders(pkg)` reads `${pkg}/backend`, finds every exported provider class, calls `new providerClass(server, lincdServer)` for each.
2. **Boot hooks** — `setupBeforeControllers()`, `setupBeforeCatchAllControllers()`, `setupAfterControllers()` run in that order during server startup.
3. **Per-request** — `initRequest(req, res)` then `supplyDataForRequest(req, res, data)` on every incoming request.
4. **Dispose** — `dispose()` runs when the provider is being torn down. In dev mode this happens on HMR (a watched source file in the same package changed) and on graceful shutdown. In production it only runs on shutdown.

The dispose step is what makes hot-reload safe. Without it, anything the constructor or boot hooks registered — Express routes, middleware, listeners, timers, global-singleton mutations — would accumulate every time the source file changed. The framework calls `dispose()` on the OLD provider before replacing it with a freshly-instantiated one.

### When to implement `dispose()`

Implement `dispose()` when your provider does any of the following at construction or boot:

- Registers Express routes (`this.server.get/post/...`) or middleware (`this.server.use(...)`).
- Holds `setInterval` / `setTimeout` handles.
- Subscribes to event listeners (LINCD events like `onAccountWillBeRemoved`, or any `EventEmitter`-style API).
- Mutates a global singleton (e.g. `LinkedStorage.setDefaultDataset(...)`, `Auth.userType = ...`).
- Opens long-lived connections (DB pools, WebSockets) that the framework can't close on its own.

If your provider only exports class definitions or implements stateless RPC methods, you don't need to override `dispose()` — the base class's no-op is correct.

### Route tracking helpers

`BackendProvider` ships two protected helpers to make route disposal one line:

```typescript
protected registerRoute(
  method: 'get' | 'post' | 'put' | 'delete' | 'patch' | 'use',
  path: string,
  handler: express.RequestHandler,
): void;

protected disposeRoutes(): void;
```

`registerRoute()` does the underlying `this.server.<method>(path, handler)` call AND pushes the entry onto `this.trackedRoutes`. `disposeRoutes()` walks `this.server._router.stack` and splices out every layer the provider registered.

For middleware (`method === 'use'`), pass `'/'` as the path to mount globally. Specific mount paths are also supported.

### Examples

**A route-registering provider:**

```typescript
export default class MyProvider extends BackendProvider {
  setupBeforeControllers() {
    this.registerRoute('get', '/api/things', async (_req, res) => {
      res.json({things: await Thing.getAll()});
    });
    this.registerRoute('post', '/api/things', async (req, res) => {
      const t = await Thing.create(req.body);
      res.json(t);
    });
  }

  async dispose() {
    this.disposeRoutes();
  }
}
```

**A stateful provider with a timer and a listener:**

```typescript
export default class CacheProvider extends BackendProvider {
  private refreshTimer?: NodeJS.Timeout;
  private invalidationListener?: (id: string) => void;
  private cache = new Map<string, any>();

  constructor(s: any, ls: any) {
    super(s, ls);
    this.refreshTimer = setInterval(() => this.refresh(), 60_000);
    this.invalidationListener = (id) => this.cache.delete(id);
    someEvents.on('thing-changed', this.invalidationListener);
  }

  async dispose() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.invalidationListener) {
      someEvents.off('thing-changed', this.invalidationListener);
    }
    this.cache.clear();
  }

  async refresh() { /* ... */ }
}
```

**A provider that mutates a global singleton:**

Such singletons (e.g. `LinkedStorage.setDefaultDataset`) often hold live connections that survive HMR by design — recreating them every reload would tear down working DB handles. Do NOT undo the mutation in `dispose()`; document that this part of the provider only updates on full restart (the `r<enter>` shortcut in `linked start`).

> **Note on disposal time:** if your `dispose()` takes longer than ~5 seconds it will be abandoned with a warning so HMR doesn't stall the dev loop. In-flight requests held by the old provider keep running on the old code; new requests hit the new instance.

## Shapes

This section will be a brief overview of the shapes that are included in this package, along with example usage of each
shape.

### Resizing images

`GET /resized/*` serves a resized copy of an image the app stores, generating and caching it on first request. It is
registered **before** the `apiOnly` guard, so it is available on an API-only server too.

Two forms:

```
GET /resized/<key>?w=200          # a key in the uploads store
GET /resized/x?src=<url>&h=100    # a public URL of a file in the uploads store
```

`w` and `h` are both optional but at least one is needed; with neither, the request redirects to the original under
`/uploads`. Pass one to scale by that dimension, or both to fit the exact box.

**Only images the app already stores can be resized.** A `src` that does not resolve to a key in the file store is
refused with `400 Unsupported image source`, and a key the store does not hold gives `404`. The route makes no
outbound HTTP request of its own: it reads the bytes through `LinkedFileStorage`. This matters — `src` used to be
fetched as given, which made the route an open proxy into its own network, and the result was written to the public
store and handed back as a URL.

#### Where the derivatives go

Resized images are written under a `resized/` prefix beside the original, through a file store of their own:

```ts
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { resizedImagesPurpose } from '@_linked/server/utils/resizedImagesPurpose';
import { LocalFileStore } from '@_linked/server/shapes/filestores/LocalFileStore';

// keep the originals wherever they are, but cache derivatives on the local disk
LinkedFileStorage.setStore(resizedImagesPurpose, new LocalFileStore('resize-cache'));
```

Configure nothing and it resolves to the default store, alongside the uploads — which is what the route did before
the purpose existed.

It is worth deciding rather than inheriting. A local disk cache is free and fast, but it is per-instance and goes
with the container: behind PM2 multicore or several replicas each instance resizes its own copies, and every deploy
starts cold. A cache in object storage is shared, survives deploys and can sit behind a CDN, at the cost of a PUT per
derivative. Either is reasonable; they suit different deployments.

The distinction is not only about where the bytes land. Uploads are originals and have to be kept; derivatives are
reproducible from them, so they can be cleared, rebuilt or expired on their own schedule without touching user data.


### LocalFileStore

An `IFileStore` that stores files in a local directory. Its usage follows the general pattern of other file stores in
LINCD:

- Define all storage locations when the server or application starts up
- Access methods of the file store through the `LinkedFileStorage` class
  - e.g. `LinkedFileStorage.saveFile("path/to/save-file.as", fileBuffer)`

It's important to note that this file store is not suitable for frontend usage - it's intended to be used in an
environment that has access to the [`fs` module](https://nodejs.org/api/fs.html).

```ts
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { LocalFileStore } from '@_linked/server/shapes/filestores/LocalFileStore';
import path from 'path';

// the second argument is the base folder on disk; it defaults to the server's
// upload folder (`./data/uploads`, relative to the working directory)
const pathToStore = path.join(process.cwd(), 'my-file-store');
const store = new LocalFileStore('my-file-store', pathToStore);
LinkedFileStorage.setDefaultStore(store);
```

`accessURL` comes from `SITE_ROOT`, and every path you pass to `saveFile`, `getFile`, `fileExists`, `deleteFile` and
`statFile` is relative to that base folder. Note that the URL `saveFile` returns is only meaningful when the base folder
is the server's own upload folder — that is the only folder the server serves.

Registering stores per purpose (`LinkedFileStorage.setStore`, `getStore`, `registerPurpose`) is core's concern — see
[`@_linked/core`](https://github.com/linked-cm/core), `utils/LinkedFileStorage` and `interfaces/IFileStore`. This
package declares one purpose of its own, for the image resize cache — see [Resizing images](#resizing-images).

#### Saving files

`saveFile` takes core's `SaveFileOptions` as its third argument:

```ts
await store.saveFile('report.pdf', fileBuffer, {
  mimeType: 'application/pdf',
  preventDuplicates: true,
});
```

A local file has no headers to attach, so three of the options affect local storage:

- `mimeType` — used to add a missing file extension.
- `preventDuplicates` — see below.
- `preservePath` — stores an already-generated relative object key exactly as supplied.
- `cacheControl` and `metadata` are accepted (so the same call works against an S3-backed store) and ignored.

The old positional form still works: a plain string third argument is read as the mime type, with `preventDuplicates`
following it.

```ts
await store.saveFile('report.pdf', fileBuffer, 'application/pdf', true);
```

##### Preserve generated object keys exactly

Release manifests and generated bundles refer to exact object keys. Set `preservePath: true` when those keys must not
be sanitised, lowercased, or renamed:

```ts
await store.saveFile(
  'releases/1.2.3/public/images/logo@2x.png',
  fileBuffer,
  { preservePath: true, preventDuplicates: false }
);
```

Preserved paths must be safe relative POSIX paths. Absolute paths, Windows paths, backslashes, empty segments, `.` and
`..` segments, and paths that change under normalisation are rejected. This prevents an exact-key save from escaping
the store's configured root.

Without `preservePath`, ordinary upload behaviour remains unchanged: unsafe filename characters are replaced with a
dash and a missing extension is added from `mimeType`.

##### Ordinary keys retain safe characters and case

Characters that are unsafe in a file name are still replaced with a dash, and a missing extension is still added from
`mimeType`, but the **case of the name is preserved**. A build asset named `main-hwqwrAvA.css` is stored under exactly
that name. (Lowercasing belongs to HTTP upload handling, where a browser hands over whatever the user's filesystem had —
`getUploadTarget`/`uploadSingleFileFromFormData` in `@_linked/server-utils` still do it there, before a store is ever
called.)

##### Getting the stored key back: `saveFileWithPath`

`saveFile` returns a URL, but `statFile`, `getFile`, `fileExists` and `deleteFile` take a *key*. `saveFileWithPath`
returns both, so verify-after-upload never has to guess a name back out of a URL:

```ts
const { storedPath, publicURL } = await store.saveFileWithPath(
  'main-hwqwrAvA.css',
  fileBuffer,
  { mimeType: 'text/css', preventDuplicates: false }
);

const stat = await store.statFile(storedPath); // always resolves
```

With `preservePath: true`, `storedPath` equals the validated relative path exactly. Without it,
`preventDuplicates: false` keeps the path verbatim only when it needs no sanitising and already has an extension. With
`preventDuplicates` left unspecified the random suffix is added and `storedPath` is the only place the resulting name
is reported.

##### LocalFileStore suffixes by default

`preventDuplicates` left unspecified means `true` **here**. A second save of the same name does **not** overwrite the
first: the store appends a random suffix, so `report.pdf` becomes `report_a1b2c3.pdf`. Only an explicit `false`
overwrites.

Core supplies no default of its own — an unspecified `preventDuplicates` reaches the store as `undefined` and each store
decides. Do not assume this store's choice holds elsewhere: `S3FileStore` in `@_linked/s3` overwrites by default.

#### Reading file metadata

`statFile(filePath)` returns `{size, sha256}` for a stored file, or `null` when it does not exist (or is not a regular
file). The `sha256` is a hex digest computed from the file's bytes on demand, so a caller can verify an upload it just
made:

```ts
const stat = await store.statFile('report.pdf');
if (stat === null) throw new Error('upload went missing');
if (stat.sha256 !== expectedSha256) throw new Error('content mismatch');
```

`statFile` is optional on `IFileStore`, so a caller holding an `IFileStore` rather than a `LocalFileStore` must check
that it exists before calling it.

## TODO

- [ ] Add tests
- [ ] Refactor `NodeFileStore` to `LocalQuadStore` as to not confuse FileStores with QuadStores
