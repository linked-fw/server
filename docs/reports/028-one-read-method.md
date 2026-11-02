---
date: 2026-11-01
summary: >
  Step S1 of core master plan 111 (sub-plan 027): RemoteDataset implements IDataset.readQuery and
  the server answers every read on one /call endpoint, readQuery, which replaces selectQuery and
  askQuery. The body's kind, read before decoding, picks the access rule (select and count under
  select, ask under ask); triples, terms, graph and write bodies answer 400. Minor.
packages: [server]
---

# 028 — One read method in the server (step S1)

## PR

**What changed**

- `POST /call/@_linked/server/readQuery` (`@callable('public')`) replaces the `selectQuery` and
  `askQuery` callables (removed, no alias: owner decision 3). It answers a select, a count or an
  ask. `toReadQuery` (`src/utils/queryPlane.ts`) reads the body's kind before decoding it
  (`readKindOfJSON`; a live in-process builder by `readKindOf`), decodes it as before
  (`toQueryBuilder`, the request's catalog), requires the decoded builder to be of that kind, and
  returns the access operation from the kind: `select` for a select or a count, `ask` for an ask.
  `checkQueryAccess` then also requires the IR kind to fit the operation, so a select is never
  checked as an ask or the reverse.
- Refused with 400: a triples or terms read (owner decision 4: "This server's readQuery does not
  answer triples reads"), a graph query (it goes to `graphQuery`), a write envelope, an unknown
  `op` or `kind`, a body that is not an object. Core's message is passed on, capped at 200
  characters. Every refusal runs inside `genericQuery`'s `try`, so a body naming the caller's
  transaction rolls it back. `genericQuery` now takes a `decode(json, catalog)` that returns the
  builder and its operation (writes: `writeOf('create' | 'update' | 'delete')`).
- `/api/select` (`LincdAPI.post_select`) decodes with `toReadQuery` too and checks by kind; it
  runs `LinkedStorage.readQuery`.
- `RemoteDataset.readQuery`: `switch (readKindOf(q))`; select, count and ask post to `readQuery`
  (graph expansion unchanged); triples and terms reads are refused, unsent. `supports` is
  `['ask']`, plus `'transactions'` after a ping that lists them (was `undefined` /
  `['transactions']`). `Method` type: `readQuery` replaces `selectQuery`/`askQuery`.
  `graphQuery` and the writes are unchanged.
- Tests: new `src/tests/read-double.ts` (`readQueryOf({select, ask})`, `queryJson` stand-in with a
  `__queryKind`); 14 suites converted; new cases: a select and a count checked under `select` and
  an ask under `ask` on `/call` and `/api/select`; triples, terms, graph, unknown-op, op+kind and
  over-long bodies answer 400; those bodies with a txId roll the transaction back; no
  `selectQuery`/`askQuery`/`triplesQuery`/`triplesTermsQuery` callable; `RemoteDataset` refuses
  triples and terms reads unsent and sends a dispatched ask as `op: 'ask'`.
- `readme.md` (the wire list), backlog 006 (triples and terms reads over `/call`), changeset
  `one-read-method.md` (minor), `@_linked/core` range `^2.46.0` (package.json and the lockfile's
  root entry).

**Verification** (worktree `one-read-method--s1`, against the master's core at `344065c`; no
server, no Fuseki; cn-main untouched)

- `linked build` (the main checkout's binary), 5 s: `✔ Build successful`
- `npm test`:

  ```
  Test Suites: 2 skipped, 38 passed, 38 of 40 total
  Tests:       2 skipped, 543 passed, 545 total
  Snapshots:   0 total
  ```
- `npx tsc -p tsconfig-esm.json --noEmit`: no output, exit 0 (`tsconfig.json` is the base config
  without a module target; `tsconfig-esm.json` is the build's). Test files are typechecked by
  ts-jest.
- `grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery' src readme.md docs/architecture`:

  ```
  src/tests/rpc-exposure.test.ts:726:  it('has no selectQuery or askQuery: every read goes to readQuery', () => {
  src/tests/rpc-exposure.test.ts:728:    for (const m of ['selectQuery', 'askQuery', 'triplesQuery', 'triplesTermsQuery']) {
  ```
  Only the test that asserts these are not callable.
- Independent review (read-only, opus) on the diff: no critical or high finding; handled below.

**Deviations from the plan**

- `/api/select` checks by kind as well (plan: `LincdAPI.ts:93` rename only). Without it an ask
  posted there would run through `LinkedStorage.readQuery` while checked as a select (the IR check
  in `QueryAccess` would refuse it, but the endpoint should not depend on that).
- `docs/architecture/01-server-only-surface.md`: checked, names no method; unchanged.
- To build and test, the master worktree's `server-utils` and `cli` checkouts were built
  (`linked build`; they had no `lib/`). No source change there.

**Follow-ups**

- Backlog 006: triples and terms reads over `/call` (owner decision 4).
- Release (plan 111): the lockfile's resolved `@_linked/core` is still 2.45.0; it is refreshed when
  the server's release PR installs core 2.46 from npm.
- CN N1 rebases on this, rebuilds the server checkout and relinks.

## Details

**Commits** (`59158ad..` on `one-read-method`)

| Commit | Phase |
|---|---|
| `5bb39e7` | 1 RemoteDataset.readQuery, its suites, plan 028 |
| `a960158` | 2 the readQuery endpoint, authorization by kind, `/api/select`, the plane suites |
| `34ac38d` | 3 readme, backlog 006, changeset, core range |
| `aecf8fd` | review fixes |
| this commit | report 028, plan 028 deleted, plan 027 ticked |

**Review** (opus, read-only, on `59158ad..34ac38d`)

| Severity | Finding | Outcome |
|---|---|---|
| medium | `RemoteDataset` now declares `ask`, so a store's function `read` rule sees `operation: 'ask'` for remote asks where it saw a select `LIMIT 1` | Not a change against the released server: before C1 `RemoteDataset.askQuery` existed, so core sent asks natively to the `askQuery` endpoint, checked under `ask`. The select `LIMIT 1` was only the state between C1 and S1. The changeset now says so. |
| medium | Old client against a new server (and the reverse) gets 404 on reads; shipped as a minor | Owner decision 3 (no legacy endpoints) and the semver rule; the changeset states the 404. |
| low | Core's refusal message echoes the client's `op`/`kind` uncapped | Fixed: capped at 200 characters; test with a 5000-character `op`. |
| low | `supports` doc said the select features are the server's to check | Fixed: core refuses a grouped or min/max select unsent. |
| low | `/api/select` behaviour changes not in the changeset | Added. The `/api` write path not rolling back on a decode failure predates this; unchanged. |
| low | Untested: the decoded-kind mismatch, an `op`+`kind` body, a dispatched remote ask | `op`+`kind` and dispatched ask tested; the mismatch check is not reachable through `fromJSON` (it follows `op`), kept as a guard. |

**Decision ledger**

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 | phase 2 | Where the pre-decode kind check runs so its refusal abandons the transaction | `genericQuery` takes a `decode` callback run inside its `try`; reads pass `toReadQuery`, writes `writeOf(op)` | A separate path for reads | One code path; every refusal rolls back as before |
| 2 | phase 2 | Which kind authorizes: the body's or the decoded builder's | Both must agree (else 400); the operation follows that kind | Trust `readKindOfJSON` alone | Safety: a decoder that disagreed with the envelope could never run under the wrong rule |
| 3 | phase 2 | A live builder handed in process (`callBackendMethod`) has no `op` | Its kind from `readKindOf` (`__queryKind`) | `readKindOfJSON` on it (would read an ask as a select) | Correctness |
| 4 | phase 2 | `/api/select` would run asks via `LinkedStorage.readQuery` under the select rule | Decode with `toReadQuery`, check under the kind's rule | Refuse non-selects on `/api/select` | One explicit way, same as `/call` ⚠ risky (authorization path) |
| 5 | phase 2 | Refusal message for a body that is not a read | Core's message (capped), 400 | A fixed "Invalid query" | Says why (graph query → use graphQuery) without leaking server state |
| 6 | phase 1 | `RemoteDataset` handed a triples or terms read | Throw a plain `Error`, unsent | Send it and let the server answer 400 | Not declared in `supports`, so core never routes one there; no round trip |
| 7 | phase 1 | Test doubles across 14 suites | Helper `src/tests/read-double.ts` (`readQueryOf`, `queryJson`) | A `switch` per double | Mirrors core's `read-double.ts`; fewest moving parts |
| 8 | phase 1 | Plain-object doubles that answered `askQuery` | Declare `supports: ['ask']` | Leave asks to the select fallback | Keeps what each test exercised |
| 9 | phase 3 | Raising `@_linked/core` to `^2.46.0` before it is on npm | `package.json` and the lockfile's root entry only | Leave the range for the release PR | The plan asks for the range in this step; the release PR refreshes the resolved entry |
| 10 | phase 3 | The Verify grep hits the negative callable test | Keep the test | Build the names from fragments | It pins that the old endpoints are gone; plain names are clearer |
| 11 | verify | `npx tsc -p tsconfig.json` errors on module/target (a base config) | Typecheck with `tsconfig-esm.json`, the build's config | Change `tsconfig.json` | Out of scope; the build config is the real gate |
| 12 | setup | Master worktree's `server-utils` and `cli` had no `lib/` | Built them there (`linked build`) | Point the link farm at the main checkout | Environment maintenance; no source change |
