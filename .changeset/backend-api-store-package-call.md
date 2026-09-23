---
'@_linked/server': minor
---

`BackendAPIStore` is no longer a Shape; it addresses the backend by package name.

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
