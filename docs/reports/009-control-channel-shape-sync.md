---
summary: >
  The host control channel gained `POST /admin/sync-shapes`: the app re-syncs its registered
  shapes into its app data exactly as its boot does and answers with the count. A host that
  changed the app's shape code (Create Now's code-first shape edit) calls it so that the app,
  the only process that loads that code, writes its own shapes and hashes. Source reloads
  are serialized; a source reload alone does not sync shapes.
---

# 009 — Shape sync over the control channel

## Why

A host that edits an app's shape code cannot write the resulting SHACL itself and match
what the app writes. Core's `syncShapes` flattens inherited properties into each shape,
adds `core:isExtending` and a `core:shapeHash`, and one shape's hash can depend on others
(`Thing/image.singleOwner` lists every registered sub-shape, so adding a sub-shape changes
`Thing`'s hash). Only a process that has loaded the app's code computes the same output,
so the app's next boot rewrote what the host had written. On a branch whose data is shared
with main until its first write, that rewrite is a write.

## What

`src/utils/adminChannel.ts` holds the `/admin/*` routes (moved out of `LinkedServer`):

| Route | Answer |
|---|---|
| `GET /admin/health` | 200 `{status: 'ok'}` |
| `POST /admin/restart` | 202, then the process exits |
| `POST /admin/sync-shapes` | 200 `{written, orphanScope, reloaded, shapes}` or `{written: 0, skipped, …}`; 400 `{error}` for a malformed body or a package it may not reload; 500 `{error}` when the sync fails or times out |

All of them need `x-cn-admin-secret` equal to `CN_APP_ADMIN_SECRET` (401 otherwise) and
answer 404 when the process has no secret.

`LinkedServer.resyncShapes({packages})`, queued so syncs never overlap and run as the system:

1. For each named package, in dev (Vite): invalidate every module under the package's
   directory (outside `node_modules`) in Vite's module graph
   (`src/utils/reloadSource.ts`), then `onSourceChange(pkg)`, which reloads the package's
   backend and with it its shapes barrel. Vite's own watcher does the same a moment later;
   the host cannot rely on it having seen a file it has just written. Without Vite (a built
   app) nothing is reloaded.
2. The same sync the boot runs (`syncRegisteredShapes`, the `syncShapesOnBoot` and
   `LINKED_SYNC_SHAPES_ON_BOOT` switches and the orphan policy included). Unlike the boot,
   a failure is returned to the caller instead of logged.

`onSourceChange` now runs one reload at a time inside the server, since both the CLI's
watcher and `resyncShapes` call it.

## Found

A source reload (HMR) never synced shapes: the watcher only re-indexes backend providers.
An older comment on the boot sync said it re-ran on shape-file HMR; it did not.

## Verification

Unit: `src/tests/admin-channel.test.ts` (routes, secret, body parsing, error mapping, the
module-graph invalidation). Live, on a copy of a Create Now project app with this build
installed and `appData` on a scratch Fuseki dataset: boot wrote 20 shapes; after writing
`Task.ts` and its barrel line, `POST /admin/sync-shapes {"packages":["…-assets"]}` answered
`{"written":2,"orphanScope":"none"}` (Task and Thing); a second call answered
`{"written":0}`; a restarted app logged `0 shape(s) written`.

## 3.6.1: review hardening

- **The answer says what was reloaded and registered.** `reloaded` lists the requested packages whose source was reloaded (none in a built app) and `shapes` the node shape IRIs registered afterwards. A `{written: 0}` alone could not tell "the stored shapes match" from "nothing was reloaded, so the new shape is not there"; a host checks the shape it wrote is in `shapes`.
- **`packages` is validated.** Each name must be a valid npm package name (never a path such as `..`), not an `@_linked/*` package, and the app itself or one of its direct dependencies (`assertReloadablePackages`); otherwise 400.
- **Queues cannot hang.** The sync queue and the source-reload queue time each operation out (`LINKED_SHAPE_SYNC_TIMEOUT_MS`, default 120 s; `LINKED_SOURCE_RELOAD_TIMEOUT_MS`, default 60 s): the caller gets the failure and the next operation runs.
- **README:** the control channel, and the side effects of a reload (providers disposed for a moment) and of a restart (in-flight requests dropped).
