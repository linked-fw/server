---
'@_linked/server': minor
---

Load the backend providers of installed linked packages at boot, not only those of local workspace packages.

Every `@_linked/*` package and every `"linkedPackage": true` package in the app's dependency tree — registry install, localized checkout or workspace member — now has its `/backend` providers indexed at startup, each after the linked packages it depends on. Before, a registry-installed package's provider was indexed only on the first `/call/<pkg>/...`, so its `initRequest` / `supplyDataForRequest` hooks were silent until then and its `setupBeforeControllers` / `setupAfterControllers` never ran at all. With `@_linked/auth` installed from the registry, that meant a signed-in SSR page after a restart shipped an empty request-json and failed to hydrate.

Lazy indexing on `/call` stays as a fallback and shares one in-flight indexing per package with boot, so a provider is never constructed twice. Legacy `"lincd": true` packages are still not loaded at boot.

In dev, a package's backend is now loaded by the loader that owns the package: `vite.ssrLoadModule` for what the SSR runner bundles (`ssr.noExternal` — workspaces and `SSR_ENTRY_PACKAGES`), Node's `import()` for what it leaves external. Loading an external package's `/backend` through `ssrLoadModule` evaluated that package a second time, apart from the copy the app's own imports use.
