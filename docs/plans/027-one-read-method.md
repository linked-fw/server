---
summary: >
  Sub-plan of core's master plan 111 (one read method): RemoteDataset answers every read with one
  readQuery, sent to one /call endpoint, readQuery, which replaces the selectQuery and askQuery
  callables (graphQuery stays, a write); authorization by the decoded kind. Step S1, report 028.
status: Plan
---

# 027 One read method (`@_linked/server`)

Sub-plan of the master plan
[`@_linked/core` docs/plans/111-one-read-method.md](../../../_linked-core/docs/plans/111-one-read-method.md)
(waves, status, release order, open questions). One step here: **S1**, wave 2, report **028**.

## Contracts (verbatim from the master plan; provider core unless noted)

### C-1 `IDataset.readQuery`

```ts
readQuery<Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>>;
graphQuery(query: GraphQuery): Promise<GraphResult>; // unchanged: graph kinds are writes
```

Required; replaces `selectQuery`, `askQuery?`, `triplesQuery?`, `triplesTermsQuery?` (no alias).
Every dataset answers `select` and `count`. A kind beyond the baseline is sent only to a dataset
that declares its feature; a dataset handed a kind it does not handle rejects. Must reject on
failure. **`graphQuery` stays a method of its own** (owner decision 1).

### C-2 Types and helpers (`@_linked/core/queries/readQuery`)

```ts
export type ReadQuery =
  | SelectQuery | CountQuery | AskQuery
  | TriplesQuery | TriplesTermsQuery;
export type ReadKind = 'select' | 'count' | 'ask' | 'triples' | 'triples_terms';
export type ReadResult<Q extends ReadQuery> =
  Q extends {readonly __queryKind: 'count'} ? number :
  Q extends {readonly __queryKind: 'ask'} ? boolean :
  Q extends {readonly __queryKind: 'select'} ? SelectResult :
  Q extends {kind: 'triples_terms'} ? string[] :
  Q extends {kind: 'triples'} ? Triple[] :
  never;
export function readKindOf(query: ReadQuery): ReadKind;   // throws on a mutation or a graph query
export function readKindOfJSON(json: unknown): ReadKind; // throws on a mutation envelope, a graph kind or an unknown kind
export function readFeaturesOf(query: ReadQuery): QueryFeature[];
```

### C-3 Query features

New: `'ask' | 'triples' | 'triplesTerms'` (in `ALL_QUERY_FEATURES`); there is no `'graph'`
feature (graph detection unchanged). Without `ask` an ask runs as a select `LIMIT 1` (shapeless
refused); without `triples`/`triplesTerms` those reads are refused. Routers forward through
`resolveRead`, never `child.readQuery(q)` directly.

### C-4 Terms read kind

`TriplesTermsQuery {kind: 'triples_terms'; objects?; predicates?; graphs?; recordClass?}`, parsed by
`parseTriplesTermsQuery`; `TriplesQuery` loses `objects`/`predicates`.

### C-5 Dispatch

`QueryDispatch.readQuery` (its `graphQuery?` stays); `resolveRead(target, query)` and
`dispatchRead(query, target?)` replace `resolveExistence`, `resolveCount`, `resolveTriples`,
`resolveTriplesTerms`, `dispatchTriplesQuery`, `dispatchTriplesTermsQuery` (removed).
`resolveGraphQuery`, `dispatchGraphQuery` and `assertQuerySupported` stay.

### C-6 `LinkedStorage`, `Transaction`

`LinkedStorage.readQuery(q)` replaces the read statics `selectQuery`, `askQuery`, `triplesQuery`,
`triplesTermsQuery` (owner decision 2); `LinkedStorage.graphQuery` stays. `Transaction.readQuery`
runs select, count and ask in the transaction and refuses triples and terms reads;
`Transaction.graphQuery` refuses as today; `TransactionRouter.readQuery` replaces its
`selectQuery`/`askQuery`.

### C-7 The wire (provider: this step for `@_linked/server`; CN N1 for the gateway)

- One read endpoint: `POST /call/@_linked/server/readQuery`, `{"args": [json]}`,
  `@callable('public')`. `json`: DSL-JSON for select, count and ask (`op`; absent = select),
  plain data for triples and terms (`kind`). Decode with `readKindOfJSON`, then
  `fromJSON` / `parseTriplesQuery` / `parseTriplesTermsQuery`. A graph query posted to
  `readQuery` is refused (400).
- **`graphQuery` stays its own endpoint**, unchanged (authorized under the `graph` rule,
  `authorizeGraphQuery`; a graph query with a `txId` is refused as today).
- Removed endpoints (owner decision 3, no legacy): `selectQuery`, `askQuery`. Writes,
  `graphQuery`, `ping`, `beginTransaction`, `commit`, `rollback` unchanged.
- Authorization by the decoded kind: select and count under `select`, ask under `ask`.
  Refusal codes and statuses unchanged; the endpoint name in messages becomes `readQuery`.
- The server's `readQuery` refuses `triples` and `triples_terms` with 400 (owner decision 4).
  `RemoteDataset.supports` is `['ask']`, plus `'transactions'` once `ping` lists it.
- DSL-JSON 1.10.

## S1 — `RemoteDataset.readQuery` and the `readQuery` endpoint

- **Depends on:** core C1 landed in `../wt/one-read-method/packages-local/_linked-core`.
- **Goal:** the server's query provider and `RemoteDataset` speak one read endpoint; nothing in
  this repo names a removed read method.
- **Scope:** C-7 for `@_linked/server`; `RemoteDataset` per C-1/C-3; the server's calls to
  `LinkedStorage` and `Transaction` per C-6; tests; README; changeset (minor).
- **Files:**
  - `src/shapes/quadstores/RemoteDataset.ts`: `selectQuery`/`askQuery`
    (`:384-418`) → `readQuery` switching on `readKindOf`: select, count, ask →
    `call('readQuery', await this.withReadGraphs(query.toJSON()))`; `graphQuery` stays as it is;
    triples and terms are never sent (not declared; reject if handed one). `Method` type
    (`:175-185`): drop `selectQuery`, `askQuery`, add `readQuery`. `supports` getter (`:310`) per C-7.
    The class doc (`/call/@_linked/server/<method>`).
  - `src/backend.ts`: the `selectQuery`/`askQuery` callables (`:162-209`) → one
    `@callable('public') async readQuery(json)` that branches on `readKindOfJSON(json)`:
    select/count/ask through `genericQuery(json, <'select'|'ask'>, 'readQuery', (tx, q) =>
    tx.readQuery(q), (q) => LinkedStorage.readQuery(q))`; triples/terms and graph kinds →
    `ServerCallError(400, …)`. The `graphQuery` callable stays as it is. A body that does not decode
    to a read kind → 400 (and abandon its transaction as `genericQuery` does today).
  - `src/utils/queryPlane.ts:14-16,225-229` (comments, endpoint name),
    `src/utils/ontologySync.ts:11` (check only: graph detection is unchanged).
  - `src/shapes/LincdAPI.ts:93` (`LinkedStorage.readQuery(builder)`; per open question 2).
  - `README.md:353` (the endpoint list).
  - Tests (`src/tests/`): rpc-exposure, graph-query-plane, call-errors, graph-content,
    remote-dataset, transaction-forwarding, call-semantics, boot-shape-sync,
    boot-ontology-sync, query-plane-hardening, query-plane-catalog, graph-writer,
    remote-dataset-ask, remote-dataset-graphs.
  - `.changeset/one-read-method.md` (minor).
- **Pitfalls:**
  - `readKindOfJSON` must run before `toQueryBuilder`/`fromJSON`: `fromJSON` throws on plain-data
    kinds, and that throw must not become a 500 or skip the transaction abandon.
  - Authorization must use the decoded kind's operation; a select body must not be authorized as
    an ask or the reverse (the `endpoint` argument is only for messages). The master runs
    an independent review on this.
  - `rpc-exposure.test.ts` lists the callable methods; CN runs in `enforce`, and `readQuery`
    must be `@callable('public')` or CN's browser `RemoteDataset` (no-url form) is refused.
  - `RemoteDataset` must not declare `ALL_QUERY_FEATURES`: today it declares nothing but
    `transactions`, so a grouped select is checked by the server's stores; keep that.
- **Architecture:** `docs/architecture/01-server-only-surface.md` (no mention of the methods;
  check the callable surface section still holds); CN arch-07 (the data server wire) is updated
  by CN N2.
- **Tests (landing gate):** server `npm test`; the touched test files above; core's
  `remote-dataset`-related tests are in core's C1.
- **Verify:**
  - `cd ../wt/one-read-method--s1/packages-local/_linked-server && npx linked build`
  - `npm test` (quote the jest summary).
  - `npx tsc -p tsconfig.json --noEmit` (or the repo's typecheck config).
  - `grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery' src README.md docs/architecture`
    → nothing that names an endpoint or a dataset method (`graphQuery` stays).
- **Done when:** S1's Verify passes, report `docs/reports/028-one-read-method.md` written,
  changeset in, this plan's progress ticked.
- **Size:** medium, 3 phases (RemoteDataset; the endpoint and its authorization; tests, README,
  changeset). Its own plan doc is `docs/plans/028-one-read-method.md`, seeded from this section
  and deleted before it lands (the report takes number 028).

## Progress

- [ ] S1 — report 028
