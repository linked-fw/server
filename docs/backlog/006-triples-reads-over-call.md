---
summary: >
  The server's readQuery refuses triples and terms reads (kind 'triples', 'triples_terms') with
  400, and RemoteDataset does not declare them. Answering them over /call needs an access rule for
  shapeless reads (a triples read names no shape) before the server routes them through
  LinkedStorage.readQuery and RemoteDataset declares 'triples' / 'triplesTerms'.
packages: [server]
---

# 006 — Triples and terms reads over `/call`

Source: core master plan 111 (one read method), owner decision 4; step S1 (report 028).

`LincdServerBackendProvider.readQuery` (`src/backend.ts`, decoding in `toReadQuery`,
`src/utils/queryPlane.ts`) answers select, count and ask. A body of kind `triples` or
`triples_terms` answers 400 ("This server's readQuery does not answer triples reads"), and
`RemoteDataset.readQuery` refuses both kinds without sending them; its `supports` lists `ask` only
(plus `transactions`). CN's gateway answers triples and terms reads on its own `readQuery`, under
its `triples` operation.

To do:

- An access rule for a shapeless read: a triples or terms read names nodes and predicates, not a
  shape, so `checkQueryAccess`'s store mapping (by the shapes a query touches) does not apply.
  Decide which stores it may reach (every dataset `LinkedStorage.readQuery` fans it out to) and
  which rule decides (a new `triples` operation in `@_linked/server-utils`' `QueryAccess`, as the
  gateway has, or `read`).
- Decode with `parseTriplesQuery` / `parseTriplesTermsQuery` after `readKindOfJSON`, run through
  `LinkedStorage.readQuery`; refuse a txId (a `Transaction` does not run them).
- `RemoteDataset` declares `'triples'`, `'triplesTerms'` and `'triplesPattern'` and sends them.
