---
"@_linked/server": minor
---

Load each linked package's backend from the directory it is installed in, not by its bare name.

The backend entry used to be loaded with `import('<pkg>/backend')`, which Node resolves from @_linked/server's own location. A linked package installed only nested inside another package's `node_modules` (npm does this when the root cannot share one version, e.g. `@_linked/owl/node_modules/@_linked/rdfs`) could therefore never be loaded: boot logged a red "Cannot find package" error for packages without a backend, and a nested package WITH a backend never had its providers constructed, its request hooks never ran, and `/call` to it answered 501.

Now the server keeps the path discovery found for every linked package, resolves the `./backend` entry from that package's own `exports` (new `resolveBackendEntry`: exact key, `./*` patterns, `import`/`node`/`default` conditions; legacy layout without `exports`) and imports it by file URL. Whether a package has a backend is decided before anything is imported: no entry is quiet, and a backend file that fails to load is a loud error naming the package and the file, without stopping other packages. The error-text matching that used to tell the two apart is gone.

When a linked package is installed more than once, only the copy the app itself resolves is loaded, and the server warns once with every copy's version and path and a hint to run `npm dedupe`.
