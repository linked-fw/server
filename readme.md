# LINCD Server

This package provides a `LincdServer` which can be used to instantiate a LINCD backend environment on node.js.

If you use `npx lincd-cli create-app [name]` it will already set everything up for you to use `LincdServer`.
To see how it's used, open `your-site/backend/server.js`.

If you require any additional features, feel free to make a request at the LINCD Discord server.
If you want to further adjust the functionality of LincdServer yourself, either extend it or clone this repo locally.

---

## Table of contents

- [Environment Variables](#environment-variables)
  - [Ontology and shape graphs](#ontology-and-shape-graphs)
  - [Where asset URLs come from](#where-asset-urls-come-from)
- [Calling methods on the backend](#calling-methods-on-the-backend)
  - [Shape providers](#shape-providers)
  - [Generic backend providers](#generic-backend-providers)
  - [Which methods a client may call (`server.rpcExposure`)](#which-methods-a-client-may-call-serverrpcexposure)
  - [Gotchas](#gotchas)
  - [Error semantics](#error-semantics)
- [Query stores](#query-stores)
  - [Without `url`](#without-url)
  - [With `url`](#with-url)
  - [`ping`](#ping)
  - [Shape catalog per request](#shape-catalog-per-request)
- [API-only servers (`server.apiOnly`)](#api-only-servers-serverapionly)
- [Host control channel (`/admin/*`)](#host-control-channel-admin)
  - [Ontology sync and the shape check](#ontology-sync-and-the-shape-check)
  - [Shape graphs](#shape-graphs)
- [Provider lifecycle and HMR](#provider-lifecycle-and-hmr)
  - [When a provider throws, and refusing to start](#when-a-provider-throws-and-refusing-to-start)
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

# Optional. Where the boot syncs keep the packages' ontology data and shapes:
# 'package' (the default), 'default', or the absolute IRI of one shared graph.
# See "Ontology and shape graphs" below.
LINKED_ONTOLOGY_GRAPH=package
LINKED_SHAPE_GRAPH=package
```

### Ontology and shape graphs

`LINKED_ONTOLOGY_GRAPH` and `LINKED_SHAPE_GRAPH` set core's graph targets (`ontologyGraph`,
`shapeGraph`). They are **one global setting of the process**, not a store's: no store, store
option or datasets config entry takes them.

| Value | The ontology sync writes | The shape sync writes |
|---|---|---|
| `package` (default, or unset) | one graph per package, `{package IRI}/graph/ontology` | one graph per package, `{package IRI}/graph/shapes`, and the app's graph `{DATA_ROOT}/graph/shapes` |
| `default` | the whole ontology into the default graph | every shape into the default graph |
| an absolute IRI | one shared graph at that IRI, holding every package | one shared graph at that IRI, holding every package and the app's generated shapes |

At boot, before the boot initialises the stores and before the syncs, the server checks both variables:
a value that is neither keyword nor an absolute IRI, one IRI for both, a portable graph name
(`graphs.*`), a store-native name (`urn:x-arq:…`) or a package's own graph name
(`…/pkg/{slug}/graph/ontology` or `/graph/shapes`) stops the boot with a fatal error naming the
variable. It then calls core's `setGraphTargets` once with them (an unset variable is `package`).
Every store's readers follow the same setting (`graphs.allOntologies`, `graphs.allShapes`).
`GET /admin/routes` reports the setting (`graphTargets`) and the variables as set.

**The frontend needs nothing.** A browser's `.from(graphs.allOntologies)` or
`.from(graphs.allShapes)` reaches the backend as the portable name, and the backend's store
expands it under the backend's setting.

**The syncs write into the default dataset only.** When the app's routing pins the shape shapes
(`NodeShape`, `PropertyShape`) or the ontology term shapes (the class and property shapes core,
`@_linked/rdfs` and `@_linked/owl` register: `rdfs:Class`, `owl:Class`, `rdf:Property`,
`owl:ObjectProperty`, `owl:DatatypeProperty`, `owl:AnnotationProperty`) to another dataset, the
boot logs one warning naming those shapes (and their sub-shapes) and their dataset: reads of them
there do not see what the syncs wrote.

Switching modes needs clearing first: the syncs never copy data from one mode's place to another's,
and a sync that finds another mode's data logs one warning and leaves it. The modes, the rule that a
package's Turtle is the source of its terms, and how to clear are in `@_linked/core`'s README
("Ontology and shape graphs"). Apps that Create Now manages must run `package` for both.


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

### Which methods a client may call (`server.rpcExposure`)

A `/call/...` request reaches only provider methods declared with `@callable('public' | 'signed-in')` (`'user'` is a deprecated alias of `'signed-in'`, treated and reported exactly like it); `@internal()` methods are never reachable over HTTP. The declarations, what each level does, and the rule for methods that act for a signed-in user are documented in one place: [server-utils: Which provider methods a client may call](https://github.com/linked-fw/server-utils#which-provider-methods-a-client-may-call).

`server.rpcExposure` sets what happens to an undeclared method: `'warn'` (the default) runs it and logs it once, `'enforce'` answers `501`. Without the config key, the `LINKED_RPC_EXPOSURE` environment variable sets it.

```typescript
new LinkedServer({
  server: {
    rpcExposure: 'enforce',
    //...
  },
});
```

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
- **`RemoteDataset` without `url`.** It always uses `rejectOnError`, so a failed query rejects with the status and message. A successful call resolves with whatever the provider returned, `undefined` included.

## Query stores

`RemoteDataset` is an `IDataset` whose Linked Queries are answered by a linked server instead of
by the store itself. It ships `query.toJSON()` and resolves with the plain JSON the server
returns; it offers no raw SPARQL (`rawQuery`), dataset administration or change feed.

Export path `@_linked/server/shapes/quadstores/RemoteDataset` (named export `RemoteDataset`, so
`loadStores` resolves it by the last path segment). One class, two forms:

| | no `url` | with `url` |
| --- | --- | --- |
| Answered by | this app's own backend | a remote data server, e.g. a host's gateway |
| Sends through | `Server.call`'s package form (`/call/@_linked/server/<method>`); on a backend, `Server`'s local shortcut | `globalThis.fetch` to `{url}/call/@_linked/server/<method>`, never `Server` |
| Authenticated by | the user's session | `Authorization: Bearer <token>` |
| `init()` | resolves at once | posts `ping`, throws a typed error when the server cannot be used |
| Typical config | `linked.frontend.datasets.json` | `linked.backend.datasets.json` |

```typescript
export interface RemoteDatasetConfig {
  url?: string;   // data server base, e.g. http://localhost:4040/gateway; routes are appended
  token?: string; // sent as Authorization: Bearer <token> when set and url is set
  name?: string;  // id = ${DATA_ROOT}/backend-api-store/<name>; does not affect routing
  id?: string;
  forwardUserToken?: boolean | string; // url form: send the signed-in user's access token (default true)
}
```

`new RemoteDataset('main')` is the `name` form.

### Without `url`

Every query is `Server.call(packageName, { method, rejectOnError: true }, query.toJSON())`, and
this package's generic provider answers it from the backend's `LinkedStorage`. Its error
semantics are under [Error semantics](#error-semantics). `token` is ignored.

### With `url`

```json
{
  "datasets": {
    "appData": {
      "store": "@_linked/server/shapes/quadstores/RemoteDataset",
      "config": { "url": "${DATA_SERVER_URL:-}", "token": "${DATA_SERVER_TOKEN:-}" }
    }
  }
}
```

- Each method posts `{"args": [<query.toJSON()>]}` to `{url}/call/@_linked/server/<method>`
  (`selectQuery`, which also carries counts, `askQuery`, `updateQuery`, `createQuery`,
  `deleteQuery`) with `Content-Type` and `Accept` set to `application/json` and, when `token` is
  non-empty, `Authorization: Bearer <token>`. It resolves the parsed body; `null` is a valid
  result. Nothing is retried, so a write is never applied twice.
- **The user's token.** When the query is made while a signed-in user's HTTP request is being
  answered (the call context is `http`), the post asks the hook on
  `globalThis[Symbol.for('@_linked/auth:userTokenHeaders')]` (exported as
  `USER_TOKEN_HEADERS_HOOK`; `@_linked/auth`'s backend installs it) with the request and
  `{method: 'POST', url}` (the exact URL posted to). When it answers, the post also carries
  `x-linked-user-token: <the user's Solid-OIDC access token>` (exported as `USER_TOKEN_HEADER`) and
  `DPoP: <a proof for this one request>`, beside the bearer. auth answers for a session signed in
  through an issuer that gave a DPoP-bound JWT access token (webid.email does), while the token has
  more than 30 seconds left; other sessions, a system context (`runAsSystem`), an anonymous request
  and code outside any call send neither. A hook that throws or answers something else sends
  neither (one warning per process) and the query still goes. The token still decides which data
  the store reaches; the data server verifies the user's token and proof (`@_linked/auth`'s
  `verifySolidAccessToken`) and acts as that user. `forwardUserToken: false` (or the string
  `"false"`) turns it off. No other headers are sent.

  > **Warning: on by default.** Every query of a signed-in user's request sends that user's access
  > token to the data server at `url`. Each proof is for one method and URL and the server cannot
  > make new ones (the key stays with the app), but it learns who the user is. Point `url` only at
  > a server you trust with your users' identities (for an app CN hosts, CN's gateway). To send
  > none, set it off in the dataset's config:
  >
  > ```json
  > "config": { "url": "${DATA_SERVER_URL:-}", "token": "${DATA_SERVER_TOKEN:-}", "forwardUserToken": false }
  > ```
- A redirect is never followed (`redirect: 'manual'`): a 3xx answer is a `RemoteDatasetError`
  with its status, so the bearer and the user's token go to `url` only.
- Trailing slashes are trimmed from `url`. A `url` that is present but empty (an unset
  `${DATA_SERVER_URL:-}`) never falls back to the no-url form: `init()` and every method throw
  `RemoteDatasetUnreachableError` with `url: ''`.
- `init()` posts `{"args": []}` to `{url}/call/@_linked/server/ping`. A success is memoized; after
  a failure the next `init()` asks again. `LinkedStorage.setDefaultDataset` does not await
  `init()`, so a boot that must fail loudly awaits it itself before registering the store.
- `init()` resolves the ping body, which the store also keeps as the readonly `info`
  (`RemoteDatasetPingInfo`, frozen; `{}` when the body is not a JSON object; `undefined` before
  a successful ping and in the no-url form). The generic ping answers `{ok: true}`; a gateway may
  add fields naming the dataset it serves (CN's adds `projectId`, `branchName`, `dataset`,
  `forked`), so a boot can log where its data goes:

  ```ts
  const info = await store.init();
  console.log(`[storage] appData: RemoteDataset at ${store.url}` +
    (typeof info?.dataset === 'string' ? ` → dataset ${info.dataset}` : ''));
  ```
- Errors, each carrying `url` (the base), `status` (0 when no HTTP answer came back) and `code`
  (the error body's `code`, when the server sent one). Messages name the url and the method,
  never the token.

  | Answer | Error |
  | --- | --- |
  | no HTTP answer | `RemoteDatasetUnreachableError` (status 0) |
  | 401 or 403 | `RemoteDatasetUnauthorizedError` |
  | on `ping` only: 404, 501, 502, 503, 504, or a body that is not JSON | `RemoteDatasetUnreachableError` |
  | any other non-2xx | `RemoteDatasetError` |

  `RemoteDatasetUnreachableError` and `RemoteDatasetUnauthorizedError` extend
  `RemoteDatasetError`, which extends `Error`; match them with `instanceof`.

### `ping`

`POST /call/@_linked/server/ping` (a `public` method of this package's generic provider) reads
nothing, changes nothing and answers `{ "ok": true }`. A plain linked server has no token
concept; a host that serves the wire with tokens checks the token itself and answers 401 for a
refused one.

### Shape catalog per request

The generic query endpoints (`/call/@_linked/server/*Query` and `/api/*`) rebuild the client's
DSL-JSON with core's `fromJSON`. By default it decodes against the global shape registry. A
host that serves several shape sets at once (for example one per project branch) supplies a
`ShapeCatalog` (from `@_linked/core`) per request:

```typescript
import { setQueryCatalogResolver } from '@_linked/server/utils/queryPlane';

// query: the DSL-JSON the client sent. Read the request itself through getCallContext().
setQueryCatalogResolver(async (query) => catalogForThisRequest(query));
```

- The resolver is called once per request, before the query is decoded. `undefined` means the
  global registry. With no resolver set, behaviour is unchanged.
- The builder keeps the catalog it was decoded in, so the access check (`withAccess` rules) and
  the store lower the query against the same shapes. A shape the catalog does not hold answers
  `400 Invalid query`.
- A resolver that throws a `ServerCallError` answers with its status and message. Any other
  throw is logged and answers `500 {"error": "Shape catalog unavailable"}`.
- A live builder passed in by backend code already carries its catalog; the resolver is not
  called for it.
- `setQueryCatalogResolver(undefined)` removes the resolver. `resolveQueryCatalog(query)` and
  `toQueryBuilder(query, catalog)` are exported for hosts that serve the same wire on their own
  routes.

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

## Host control channel (`/admin/*`)

A host that starts the app process controls it over HTTP routes on the app's own port. They exist only when the process was started with `APP_ADMIN_SECRET` in its environment; without it they answer 404. Every request carries the secret in the `x-app-admin-secret` header (401 otherwise).

| Route | Answer |
|---|---|
| `GET /admin/health` | 200 `{status: 'ok'}` once the server listens (the boot ontology sync, shape check and shape sync have finished by then) |
| `POST /admin/restart` | 202, then the process exits; the host starts it again |
| `POST /admin/graph-registry-changed` | body `{dataset}`: the host changed that dataset's named graphs; the process drops its cached graph registry and answers 200 `{invalidated: dataset}`; 400 without a dataset name |
| `GET /admin/routes` | 200 `{datasets: [{store, id?, default, routes, defaultGraphShapes}], graphTargets, graphTargetEnv}`: the effective graph routes and graph targets (see below) |
| `POST /admin/sync-shapes` | 200 `{written, orphanScope, shapeGraphs, reloaded, shapes, ontologies: {written, skipped, graphs, droppedGraphs}, shapeCheck: {errors, warnings}}` (or `{written: 0, skipped, …}` when shape sync is off); 400 `{error}` for a malformed body or a package it may not reload; 500 `{error}` when the sync fails or times out |

`POST /admin/sync-shapes` runs the ontology sync and the shape check (see [Ontology sync and the shape check](#ontology-sync-and-the-shape-check)), then re-syncs the registered shapes into the app's data exactly as the boot does (see [Shape graphs](#shape-graphs): only graphs whose stored content hash differs are written, with the boot's orphan policy and `syncShapesOnBoot` / `LINKED_SYNC_SHAPES_ON_BOOT` switches). `written` counts the shape graphs written, and `shapeGraphs` reports them. The optional body `{packages: [...]}` names packages whose source the host changed; each must be a valid npm package name and the app itself or one of its direct dependencies, never an `@_linked/*` package; the list only says what to reload, it never filters the syncs. In dev their modules are invalidated in Vite and their backends reloaded before the sync, so a shape file written a moment ago is registered; a built app reloads nothing. `reloaded` lists the packages actually reloaded and `shapes` the node shape IRIs registered afterwards, so the host can check that the shape it wrote is there. Syncs run one at a time, as the system; one that takes longer than `LINKED_SHAPE_SYNC_TIMEOUT_MS` (default 120000) fails and releases the queue. A source reload by itself (HMR) never syncs shapes. A failed ontology sync does not stop the shape sync; the route then answers 500 with the ontology error.

`GET /admin/routes` reports the graph routes the process runs with, as core's routing holds them once the app's storage file (`linked.backend.storage`) has run. Routes are written only there (`LinkedStorage.setDatasetForShapes(dataset, shapes, {graph})`); the app never pushes them anywhere, and this route lets a host check what actually runs. One entry per dataset the router knows, the default dataset first, then in the order they were pinned:

- `store`: the store's class name (`FusekiStore`, `RemoteDataset`, …), and `id` when the store has one. The server does not see the storage config's aliases, so these and `default` tell the datasets apart.
- `default`: whether it is the default dataset (the one for every shape without a pin).
- `routes`: `{<shape IRI>: <graph IRI>}` as registered. A sub-shape without a route of its own is written to its nearest routed super-shape's graph and is not listed.
- `defaultGraphShapes`: the registered shapes that resolve to this dataset and are written to its default graph (no route of their own, no routed super-shape), sorted.

`graphTargets` is the process's one graph-target setting, `{ontologyGraph, shapeGraph}` (`package`, `default` or a shared graph IRI each; see [Ontology and shape graphs](#ontology-and-shape-graphs)): where the boot syncs write, for every dataset. `graphTargetEnv` holds `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH` as the process has them (unset ones left out), so a host can tell where the setting came from.

```json
{"datasets": [{"store": "FusekiStore", "default": true,
  "routes": {"https://example.org/shape/Article": "https://example.org/data/graph/articles"},
  "defaultGraphShapes": ["https://example.org/shape/Person"]}],
 "graphTargets": {"ontologyGraph": "package", "shapeGraph": "package"},
 "graphTargetEnv": {}}
```

Side effects to expect:

- **A reload briefly disposes the package's providers.** Reloading a package (on HMR, or for `sync-shapes`) runs `dispose()` on its providers and constructs new ones; a request to that package's routes or methods that arrives in between can fail. Reloads run one at a time; one that takes longer than `LINKED_SOURCE_RELOAD_TIMEOUT_MS` (default 60000) rejects and releases the queue.
- **A restart drops in-flight requests.** `POST /admin/restart` exits the process 50 ms after answering. A host that restarts an app whose server has no `sync-shapes` route (an older `@_linked/server`) to make its boot sync the shapes drops whatever that app was serving.
- The channel listens on the app's public port, like every other route; only the secret protects it.

### Ontology sync and the shape check

Before its shape sync, at boot and on `POST /admin/sync-shapes`, the server:

1. **Registers the installed packages' ontologies** (core `registerInstalledOntologies`): it imports `lib/esm/ontologies/*.register.js` of every linked package it discovered in the app's dependency tree, so a package the app only deep-imports shape files from (`@_linked/schema/shapes/Person`) is synced and checked too, and of every workspace package of the app (`linkedPackage: true` under its `workspaces`), which no package may import (a Create Now clone's `packages/<slug>-ont`). In dev, a package without a built `lib/` registers from `src/ontologies/*.register.ts` through Vite's `ssrLoadModule`; a built app skips it. A register module that fails is logged and the rest go on.
2. **Syncs the ontologies** (core `syncOntologies`): every registered package's ontology data is written into the app's default dataset, where `LINKED_ONTOLOGY_GRAPH` says (one graph per package by default; see [Ontology and shape graphs](#ontology-and-shape-graphs)), so the store's RDFS view infers the class hierarchy. The log line names a shared graph or the default graph when the sync wrote there. A package whose stored hash matches is skipped, so an unchanged sync writes nothing. `ontologies.written` and `ontologies.skipped` name the packages (a package whose data cannot be read is skipped with core's warning). Sync nodes of packages no longer registered are pruned only with `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true`, the shape sync's orphan policy.
3. **Checks the shapes** against that hierarchy (core `checkShapeHierarchy`, with every package's `dependencies` and `peerDependencies`). A running app is never stopped by it: each finding is logged, and `shapeCheck` counts them by severity.

The ontology sync follows the shape sync's switches (`syncShapesOnBoot`, `LINKED_SYNC_SHAPES_ON_BOOT`), at boot and on `POST /admin/sync-shapes` alike: with shape sync off, the route syncs neither ontologies nor shapes (it still registers the packages' ontologies and runs the shape check). `LINKED_SYNC_ONTOLOGIES_ON_BOOT=false` turns off only the boot's ontology sync. The in-memory class hierarchy (core `loadOntologyHierarchy`) is loaded at boot either way. A failed ontology sync at boot is logged and the boot goes on.

### Shape graphs

After the ontology sync and the shape check, at boot and on `POST /admin/sync-shapes`, the server syncs the registered shapes into the app's default dataset with core's `syncShapeGraphs`. This section describes the default, `LINKED_SHAPE_GRAPH=package`; with a shared graph IRI every package's shapes and the app's generated ones go into that one graph (`graphs` lists it, `appGraph.graph` is it), and with `default` the shapes go into the default graph (`defaultGraph` counts the writes). See [Ontology and shape graphs](#ontology-and-shape-graphs).

- **One graph per package.** Each package's shapes go in `{package IRI}/graph/shapes`, with a `ShapesGraph` record in the graph registry (never a hierarchy source). A graph whose stored content hash matches is not written, so an unchanged sync writes nothing; a changed one is replaced whole.
- **Where the Turtle comes from.** An installed package's built `lib/esm/data/shapes.ttl`, which `linked build` writes. An installed package without that file gets no shape graph: nothing is generated for it (a package with no shapes has none). The app's own packages (the app and its workspace packages) are generated in process: in dev through Vite's `ssrLoadModule` (core's `packageShapesTurtle` on the core the source shapes registered on, the same bytes `linked build` writes); in a built app from their `lib/esm/data/shapes.ttl` when they have one.
- **The app's own shape graph.** The single-owner shapes core generates from `contains` properties go in `{DATA_ROOT}/graph/shapes`, regenerated each sync (hash-skipped like the rest). Without `DATA_ROOT` there is none.
- **Earlier syncs.** Shapes an earlier server wrote into the default graph are removed there once their package's graph holds them. A store without graph queries gets that default-graph sync instead.
- **Orphans.** With `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true` the shape graphs of packages no longer registered are dropped (never the app's own graph); core prunes only when every registered package has Turtle, so a package without `shapes.ttl` skips the pruning with a warning.

The boot logs one line, for example:

```
[LinkedServer] shape graph sync: written @acme/shop; skipped @_linked/schema; app graph written; graphs written https://linked.cm/pkg/acme-shop/graph/shapes, https://acme.example/data/graph/shapes; no shapes.ttl (no shape graph): @acme/legacy
```

`POST /admin/sync-shapes` answers the same as `shapeGraphs`: `{written, skipped, pruned, graphs, appGraph: {graph, status}, withoutTurtle, cleaned, target}` (plus `defaultGraph`, the default-graph sync's writes, under `LINKED_SHAPE_GRAPH=default` or on a store without graph queries). `target` is the process's `shapeGraph` setting (see [Ontology and shape graphs](#ontology-and-shape-graphs)); with `fallback` set the store had no graph queries and the shapes went into the default graph instead. In a shared graph the rebuild covers the packages with Turtle: a package without it is left out (and logged), where the package mode keeps its old graph.

## Provider lifecycle and HMR

Every provider — generic (`BackendProvider`) or shape-scoped (`ShapeProvider`) — has a lifecycle the framework drives:

1. **Construction** — `LincdServer.indexPackageBackendProviders(pkg)` loads the package's `./backend` entry, finds every exported provider class, calls `new providerClass(server, lincdServer)` for each. The entry is resolved from the directory where the package is actually installed — including a copy nested in another package's `node_modules` — through its `exports` map (`./backend`, or a `./*` pattern, with the `import`/`node`/`default` conditions), and imported by file URL. A package whose exports map to no existing file has no backend and is skipped quietly; a backend file that exists but fails to load is logged as an error naming the package and the file. If a linked package is installed more than once, only the copy the app itself resolves is loaded, with a warning to run `npm dedupe`.
2. **Boot hooks** — `setupBeforeControllers()`, `setupBeforeCatchAllControllers()`, `setupAfterControllers()` run in that order during server startup.
3. **Per-request** — `initRequest(req, res)` then `supplyDataForRequest(req, res, data)` on every incoming request.
4. **Dispose** — `dispose()` runs when the provider is being torn down. In dev mode this happens on HMR (a watched source file in the same package changed) and on graceful shutdown. In production it only runs on shutdown.

The dispose step is what makes hot-reload safe. Without it, anything the constructor or boot hooks registered — Express routes, middleware, listeners, timers, global-singleton mutations — would accumulate every time the source file changed. The framework calls `dispose()` on the OLD provider before replacing it with a freshly-instantiated one.

### When a provider throws, and refusing to start

A provider that throws is isolated: a failing constructor, a backend module that throws when it loads, or a boot hook that throws or rejects is logged with the package and hook name (`[linked] <pkg> <hook> failed: …`), and the rest of the app still starts without it. Per-request hooks (`initRequest`, `supplyDataForRequest`) are isolated the same way — the request is served with the other providers' data.

Sometimes a provider must not let the app serve at all — auth with no signing secret in production, say, where serving anyway looks healthy and fails every sign-in. For that, throw an error with an **own property `fatal` set to `true`**:

```ts
// No dependency on @_linked/server needed:
throw Object.assign(new Error('JWT_SECRET is not set'), {fatal: true});

// or, with the helper:
import {FatalStartupError} from '@_linked/server/utils/fatalError';
throw new FatalStartupError('JWT_SECRET is not set');
```

Thrown while the server boots — from a provider constructor, a backend module's top level, or `setupBeforeControllers` / `setupBeforeCatchAllControllers` / `setupAfterControllers` — it is logged as `[linked] <pkg> <hook>: fatal error, refusing to start: <message>`, `start()` (and `initOnly()`) rejects with it before the server listens, and the process exits with code 1. The exit code is set immediately; because a rejected `start()` alone does not end a process that still has a Vite dev server, a store connection or a timer open, the server also calls `process.exit(1)` a second later (an embedder can override `exitAfterFatalStartupError`). `isFatalError(err)` checks the contract.

Thrown after boot — from a per-request hook, a backend loaded lazily by a later `/call`, or an HMR reload — the error is logged as fatal (`… fatal error after start, server keeps running: …`) and contained like any other: one provider does not take down a server that is already serving. A provider that must refuse should therefore decide at construction or in a boot hook.

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
[`@_linked/core`](https://github.com/linked-fw/core), `utils/LinkedFileStorage` and `interfaces/IFileStore`. This
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

## Shared state and error brands

A module of this package can be evaluated twice in one process (Vite's SSR runner and Node under
`linked start`). The settings `LinkedServer` applies from config — `server.rawQueries`,
`server.rpcExposure` — and the host's `setQueryCatalogResolver` are kept on `globalThis` with
`sharedState` from `@_linked/core`, so a second copy never falls back to its default. The process
setup (the cookie-jar `fetch`, the `process` error listeners) runs once per process. The error
classes `RemoteDatasetError`, `RemoteDatasetUnreachableError`, `RemoteDatasetUnauthorizedError` and
`FatalStartupError` are branded: match them with `isLinkedError(err, RemoteDatasetUnreachableError)`
from `@_linked/core`, not `instanceof`. See
[shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md).
