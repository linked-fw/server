---
'@_linked/server': minor
---

The host control channel no longer reads the deprecated `CN_APP_ADMIN_SECRET` and
`x-cn-admin-secret` names that 3.9.0 still accepted. Its secret comes from `APP_ADMIN_SECRET` and
the `x-app-admin-secret` header only.

Breaking changes:

- `CN_APP_ADMIN_SECRET` is no longer read: a process started with only that variable has no
  control channel (every `/admin/*` route answers 404). Set `APP_ADMIN_SECRET`.
- The `x-cn-admin-secret` header is no longer read: a request that carries the secret only there
  answers 401. Send `x-app-admin-secret`.
- `LEGACY_ADMIN_SECRET_ENV`, `LEGACY_ADMIN_SECRET_HEADER` and the `warn` handler of
  `registerAdminRoutes` are removed, and `resolveAdminSecret` takes only the environment.
