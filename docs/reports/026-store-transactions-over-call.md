---
summary: >
  Store transactions over `/call/@_linked/server`: `beginTransaction`, `commit` and `rollback`,
  queries with a `txId` run in the caller's transaction (rights checked as if alone), `ping` lists
  'transactions' only when every store `LinkedStorage` routes to holds them, and `RemoteDataset`
  declares them from that ping. Minor.
packages: [server]
---

# 026 — Store transactions over /call

## PR

### Summary

Core report 103's forwarding contract on the server side:

- **`RemoteDataset`**: `supports` is `['transactions']` only after a `ping` that listed them (the
  no-url form now pings its backend for this alone); `beginTransaction()`, `commit(txId)`,
  `rollback(txId)` post to the methods of the same names, never retried.
- **Generic provider** (`backend.ts`, `utils/serverTransactions.ts`,
  `utils/forwardedTransactions.ts`): the three methods; the server holds a core `Transaction` per
  txId of its own over `LinkedStorage`, only when every dataset declares 'transactions'; a query
  carrying the txId is checked with `authorizeGenericQuery` as if alone; a refusal or failure, a
  body that does not decode included, rolls the caller's transaction back. Bound to the session's
  user (401 without a session; `system` outside HTTP); another caller's txId is 403
  `transaction-not-yours` and leaves the owner's transaction alone. 501
  `transactions-unsupported`, 409 `transaction-unknown` (a rollback of one resolves); idle expiry
  30 s. `ping` answers `{ok, supports}`.
- `/api/*` and `graphQuery` refuse a txId (400). README "Store transactions"; changeset (minor).

### Verification

- Core first (report 103's live tests had been skipped): core's whole suite against a Fuseki of
  its own (`FUSEKI_BASE_URL=http://localhost:3083`, `REQUIRE_FUSEKI=1`), exit 0:
  ```
  [fuseki] live tests: 470 total — 468 passed, 0 failed, 2 skipped
  Test Suites: 4 skipped, 165 passed, 165 of 169 total
  Tests:       122 skipped, 3214 passed, 3336 total
  ```
- New `src/tests/transaction-forwarding.test.ts` (an `InMemoryDataset` behind `/call`: commit
  applies all, rollback nothing, another user's txId refused, refusals roll back, `/api` and
  graph queries refused, `RemoteDataset` from ping). Whole suite:
  `Tests: 2 skipped, 532 passed, 534 total`. `npx linked build`: `✔ Build successful`.

### Review

Reviewed with CN's report 381 (independent review, two rounds); the server's findings fixed:
refusals before the transaction left it open; a graph query with a txId ran outside; unsupported
answered after unknown; an unresolved query context ended the transaction; expiry while a query ran.

### Follow-ups

- `ForwardedTransactions` is duplicated in `@semantu/execution-gateway` (CN): move it into core.
- No per-caller cap on open transactions.
