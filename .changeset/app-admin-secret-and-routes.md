---
'@_linked/server': minor
---

The host control channel reads its secret from `APP_ADMIN_SECRET` and its requests carry it in the
`x-app-admin-secret` header. New route `GET /admin/routes` answers the graph routes the process
runs with: `{datasets: [{store, id?, default, routes, defaultGraphShapes}]}`, one entry per dataset
the router knows, `routes` as `{<shape IRI>: <graph IRI>}` as core's routing holds them once the
app's storage file has run, and the shapes each dataset writes to its default graph. Like every
`/admin/*` route it answers 404 when the process has no admin secret.

Renamed, with a fallback (each old name logs one deprecation warning per process):

- `CN_APP_ADMIN_SECRET` → `APP_ADMIN_SECRET`; the old variable is read when the new one is unset.
- The `x-cn-admin-secret` header → `x-app-admin-secret`; the old header is read when the new one
  is absent.

The secret is compared through sha256 digests of both sides, so the comparison does not reveal
its length.

No breaking changes: an app or host that sets only the old names keeps working. Requires
`@_linked/core` `^2.39.1` (`getShapeGraphs` and `graphRoutingFor` in `utils/graphRouting`).
