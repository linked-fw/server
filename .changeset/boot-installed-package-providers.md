---
'@_linked/server': minor
---

Load the backend providers of installed linked packages at boot, not only those of local workspace packages.

Every package in the app's dependency tree whose package.json declares `"linkedPackage": true` — registry install, localized checkout or workspace member — now has its `/backend` providers indexed at startup, each after the linked packages it depends on. Before, a registry-installed package's provider was indexed only on the first `/call/<pkg>/...`, so its `initRequest` / `supplyDataForRequest` hooks were silent until then and its `setupBeforeControllers` / `setupAfterControllers` never ran at all. With `@_linked/auth` installed from the registry, that meant a signed-in SSR page after a restart shipped an empty request-json and failed to hydrate.

The `"linkedPackage": true` flag is the only test, whatever the package's scope: an `@_linked/*` package without it (such as the `@_linked/localize` CLI tool) is not loaded, and a package in any other scope with it is. Legacy `"lincd": true` packages are still not loaded at boot.

Lazy indexing on `/call` stays as a fallback and shares one in-flight indexing per package with boot, so a provider is never constructed twice.

A provider whose hook throws no longer takes the server down with it. Boot lifecycle hooks (`setupBeforeControllers`, `setupBeforeCatchAllControllers`, `setupAfterControllers`) and per-request hooks (`initRequest`, `supplyDataForRequest`) now run per provider: an error is logged as `[linked] <package> <hook> failed: …` and the remaining providers still run. Before, a throwing boot hook aborted startup, and a synchronous throw in `supplyDataForRequest` failed every page request without naming the provider. This applies to local workspace providers as well as installed ones.

In dev, a package's backend is now loaded by the loader that owns the package: `vite.ssrLoadModule` for what the SSR runner bundles (`ssr.noExternal` — workspaces and `SSR_ENTRY_PACKAGES`), Node's `import()` for what it leaves external. Loading an external package's `/backend` through `ssrLoadModule` evaluated that package a second time, apart from the copy the app's own imports use.

Apps should be on `@_linked/sentry` 1.1.3 or later: before that, its `setupBeforeControllers` called `require` in ESM and threw `ReferenceError: require is not defined` whenever `SENTRY_DSN` and `SITE_ROOT` are set outside development. Now that that hook runs at boot, an older version logs the error instead of aborting startup, but Sentry stays inactive.
