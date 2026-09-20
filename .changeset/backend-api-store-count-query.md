---
'@_linked/server': patch
---

`BackendAPIStore` now implements `IDataset.countQuery`, ahead of `@_linked/core` making that method required.

The count crosses the wire exactly like the other query kinds: the client store ships `query.toJSON()` through `Server.call` with `rejectOnError`, and the envelope keeps its `op: 'count'` discriminator so a backend that predates count rejects it loudly instead of reinterpreting it as a select and answering with rows. Nothing rewrites a count as a select and counts the rows — a wrong count is a plausible number rather than a visible failure.

Note that the backend half is not there yet, by design: `BackendAPIStoreProvider` has no `countQuery` handler because core's `LinkedStorage` exposes no count entry point and no concrete store implements one, so a count call rejects with a `ServerCallError` naming the missing provider method until core lands storage-side counting.
