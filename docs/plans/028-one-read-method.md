---
summary: >
  Step S1 of core master plan 111 (sub-plan 027): RemoteDataset.readQuery and the server's one
  readQuery endpoint, authorized by the decoded kind. Seeded from plan 027's S1; deleted at landing
  (report 028 takes the number).
status: Tasks
---

# 028 One read method (`@_linked/server`, step S1)

Scope, contracts and pitfalls: [plan 027](./027-one-read-method.md) (C-1..C-7, S1). This doc holds
the phases, their validation and the decision ledger.

## Design

- `queryPlane.ts` gains `toReadQuery(json)`: the kind of the body (`readKindOfJSON`; a live
  builder by `readKindOf`) before any decoding; `triples` and `triples_terms` refused with 400
  (the server has no triples reads); a graph kind, a mutation envelope or garbage 400. Then the
  catalog and `toQueryBuilder`, then the decoded builder's own `readKindOf` must equal the body's
  kind (else 400). Returns `{query, operation}` with `operation` from the decoded kind: `select`
  for select and count, `ask` for ask.
- `backend.ts`: `genericQuery` takes a `decode(json)` that returns `{query, operation}` and runs
  inside its `try` (so every refusal abandons the body's transaction as today). Writes pass a
  fixed operation; `readQuery` passes `toReadQuery`. `selectQuery`/`askQuery` callables removed.
- `RemoteDataset.readQuery`: `switch (readKindOf(q))`: select, count, ask →
  `call('readQuery', withReadGraphs(q.toJSON()))`; triples, terms → reject. `supports`:
  `['ask']` plus `'transactions'` after a ping that lists them.

## Phases

### Phase 1 — RemoteDataset

- `readQuery`, `Method` type, `supports`, class doc.
- Validation: `npx tsc -p tsconfig.json --noEmit` shows no error in `RemoteDataset.ts`;
  `npx jest src/tests/remote-dataset*.test.ts src/tests/call-semantics.test.ts` after their
  conversion (tests converted in this phase for these files).

### Phase 2 — the endpoint and its authorization

- `toReadQuery` in `queryPlane.ts`; `genericQuery`'s `decode`; `readQuery` callable;
  `LincdAPI.ts` → `LinkedStorage.readQuery`; queryPlane comments.
- Tests: rpc-exposure, query-plane-hardening (incl. new: a select body authorized as select, an
  ask body as ask, a count as select; triples / terms / graph bodies 400; a txId body refused and
  abandoned), query-plane-catalog, transaction-forwarding, call-errors, graph-query-plane,
  graph-content, graph-writer, boot-shape-sync, remote-dataset-ask.
- Validation: those suites pass; typecheck clean.

### Phase 3 — README, docs, changeset

- `readme.md` endpoint list; `docs/architecture/01-server-only-surface.md` check; changeset
  (minor, `@_linked/core` range raised to `^2.46.0`); backlog item for triples/terms reads over
  the server's `/call`.
- Validation: plan 027's Verify (build, `npm test`, typecheck, grep).

Dependencies: 1 → 2 → 3 (2's tests use 1's `RemoteDataset`). No parallel work.

## Progress

- [x] Phase 1 (RemoteDataset suites and call-semantics: 77 passed)
- [ ] Phase 2
- [ ] Phase 3

## Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
