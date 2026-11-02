---
'@_linked/server': minor
---

Store transactions over `/call`: `beginTransaction`, `commit(txId)` and `rollback(txId)` on the generic provider, and queries that carry a `txId` run in the caller's transaction (checked against the store rules as if sent alone; a refusal rolls it back). The server holds transactions only when every dataset `LinkedStorage` routes to declares `'transactions'`, and its `ping` then answers `supports: ['transactions']`. A txId is bound to the session's user; another caller's is refused. `RemoteDataset` declares `'transactions'` after such a ping (the no-url form now pings its backend for this), and gains `beginTransaction`, `commit` and `rollback`. A query with a txId on `/api/*`, and a graph query with one, are refused; any refusal of a request naming the caller's own transaction rolls it back.
