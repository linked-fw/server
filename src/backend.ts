import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { callable } from '@_linked/server-utils/utils/callable';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { LocalFileStore } from './shapes/filestores/LocalFileStore.js';
import type { QueryOperation } from '@_linked/server-utils/utils/QueryAccess';
import {
  authorizeGenericQuery,
  authorizeGraphQuery,
  graphQueryCallError,
  resolveQueryCatalog,
  toGraphQuery,
  toQueryBuilder,
  toReadQuery,
} from './utils/queryPlane.js';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { txIdOf } from '@_linked/core/queries/transactionQuery';
import { UnresolvedContextError } from '@_linked/core/queries/QueryContext';
import { isLinkedError } from '@_linked/core/utils/linkedError';
import type { Transaction } from '@_linked/core/utils/Transaction';
import type { ShapeCatalog } from '@_linked/core/utils/ShapeCatalog';
import {
  abandonTransactionOf,
  assertStoresHoldTransactions,
  storesHoldTransactions,
  transactionCallError,
  transactionCaller,
  transactions,
} from './utils/serverTransactions.js';
import path from 'path';
import fs from 'fs/promises';

/** A write's decoder for `genericQuery`: the body as its builder, checked under the endpoint's own rule. */
function writeOf(operation: Extract<QueryOperation, 'create' | 'update' | 'delete'>) {
  return (json: unknown, catalog: ShapeCatalog | undefined) => ({
    query: toQueryBuilder(json, catalog),
    operation,
  });
}

function assertTxId(txId: unknown): asserts txId is string {
  if (typeof txId !== 'string' || !txId) throw new ServerCallError(400, 'Expected a transaction id');
}

export default class LincdServerBackendProvider extends BackendProvider {
  async setupBeforeControllers() {
    if (!LinkedFileStorage.getDefaultStore()) {
      LinkedFileStorage.setDefaultStore(
        new LocalFileStore(process.env.NODE_ENV + '-filestore')
      );
    }
    let fileSystemUploadPath = path.join('data', 'filestores');
    try {
      await fs.access(fileSystemUploadPath);
    } catch (err) {
      await fs.mkdir(path.join(fileSystemUploadPath, 'filestores'), {
        recursive: true,
      });
    }
  }

  /**
   * Reachability check for a `RemoteDataset` pointed at this server: reads nothing, changes
   * nothing. A plain linked server has no token concept, so it always answers `{ok: true}`;
   * a host that serves the wire with tokens answers 401 for a refused one. `supports` lists
   * `'transactions'` when this server holds store transactions (every store it routes to does);
   * `RemoteDataset` declares them only then.
   */
  @callable('public')
  async ping(): Promise<{ ok: true; supports: string[] }> {
    return { ok: true, supports: storesHoldTransactions() ? ['transactions'] : [] };
  }

  // ── Store transactions ───────────────────────────────────────────────────
  //
  // `RemoteDataset.beginTransaction()` / `commit(txId)` / `rollback(txId)` (core report 103). The
  // server answers its own txId and holds a core `Transaction` for it, which opens a transaction
  // in each store a query of it routes to. The txId is bound to the caller that began it.
  // A server whose stores do not all hold transactions answers 501 `transactions-unsupported`;
  // an unknown or expired txId 409 `transaction-unknown` (a rollback of one resolves); another
  // caller's txId 403 `transaction-not-yours`.

  @callable('public')
  async beginTransaction(): Promise<string> {
    try {
      const caller = transactionCaller();
      assertStoresHoldTransactions();
      return transactions.begin(caller, LinkedStorage.begin());
    } catch (err) {
      throw transactionCallError(err);
    }
  }

  @callable('public')
  async commit(txId: unknown): Promise<void> {
    assertTxId(txId);
    try {
      await transactions.commit(txId, transactionCaller());
    } catch (err) {
      throw transactionCallError(err);
    }
  }

  @callable('public')
  async rollback(txId: unknown): Promise<void> {
    assertTxId(txId);
    try {
      await transactions.rollback(txId, transactionCaller());
    } catch (err) {
      throw transactionCallError(err);
    }
  }

  /**
   * Decode, check and run one generic query. `decode` turns the body into the builder the store
   * runs and the access rule it is checked under (a write's rule is its endpoint's; a read's
   * follows its kind, see `toReadQuery`). One that carries a txId runs in its transaction: the
   * caller's own, checked against the store rules as if it were sent alone. Any refusal or
   * failure of it (a body that does not decode included) rolls the transaction back.
   */
  private async genericQuery<R>(
    json: any,
    decode: (json: unknown, catalog: ShapeCatalog | undefined) => { query: any; operation: QueryOperation },
    endpoint: string,
    inTransaction: (tx: Transaction, query: any) => Promise<R>,
    direct: (query: any) => Promise<R>
  ): Promise<R> {
    try {
      const { query, operation } = decode(json, await resolveQueryCatalog(json));
      const authorize = () => authorizeGenericQuery(operation, json, query, endpoint);
      if (!txIdOf(query)) {
        await authorize();
        return await direct(query);
      }
      assertStoresHoldTransactions();
      return await transactions.query(
        query,
        transactionCaller(),
        async () => {
          assertStoresHoldTransactions();
          await authorize();
        },
        inTransaction
      );
    } catch (err) {
      // A select whose query context is not ready did not run: it fails nothing (as in core).
      if (!isLinkedError(err, UnresolvedContextError)) await abandonTransactionOf(json);
      throw transactionCallError(err);
    }
  }

  // ── Generic query execution ──────────────────────────────────────────────
  //
  // These answer `RemoteDataset`: a browser's store calls
  // `Server.call(packageName, {method}, json)` (the PACKAGE form), and a remote app's store
  // posts the same `{args}` body to `{url}/call/@_linked/server/<method>`. Either way the
  // request arrives here on the generic provider rather than through Shape resolution.
  //
  // A query cannot cross the wire live, so the client ships `toJSON()` and `fromJSON()`
  // rehydrates it here into a live, closed query. `LinkedStorage` then routes it by the
  // QUERY's shape, which is what decides the target dataset; the store instance never
  // participates. A query that carries a txId (DSL-JSON 1.5) runs in the caller's
  // transaction instead (see "Store transactions" above). The host's catalog resolver
  // (`setQueryCatalogResolver`) picks the shape catalog the JSON is decoded in; the builder
  // keeps it for both lowerings.
  //
  // Every query is checked first against the access rules of the stores it
  // maps to, declared in the app's storage config (`withAccess`; a store with
  // no rule requires a session): see utils/queryPlane. INTERIM model, to be
  // rethought. The store runs the builder that was checked. They are declared
  // 'public' because that check, not the RPC layer, decides whether a session
  // is required.

  /**
   * Every read: a select, a count or an ask (DSL-JSON, told apart by `op`). The body's kind picks
   * the access rule (`select` for a select or a count, `ask` for an ask; see `toReadQuery`).
   * Triples and terms reads, graph queries and writes are refused with 400.
   */
  @callable('public')
  async readQuery(json: any) {
    return this.genericQuery(json, toReadQuery, 'readQuery', (tx, q) => tx.readQuery(q), (q) => LinkedStorage.readQuery(q));
  }

  @callable('public')
  async updateQuery(json: any) {
    return this.genericQuery(json, writeOf('update'), 'updateQuery', (tx, q) => tx.updateQuery(q), (q) => LinkedStorage.updateQuery(q));
  }

  @callable('public')
  async createQuery(json: any) {
    return this.genericQuery(json, writeOf('create'), 'createQuery', (tx, q) => tx.createQuery(q), (q) => LinkedStorage.createQuery(q));
  }

  @callable('public')
  async deleteQuery(json: any) {
    return this.genericQuery(json, writeOf('delete'), 'deleteQuery', (tx, q) => tx.deleteQuery(q), (q) => LinkedStorage.deleteQuery(q));
  }

  /**
   * A whole-graph operation (`graph_create`, `graph_replace`, `graph_patch`, `graph_drop`), as
   * `RemoteDataset.graphQuery` sends it. The query is plain data: core's `parseGraphQuery` checks
   * it, the `graph` rule of the store its record class routes to decides (no rule refuses), and
   * `LinkedStorage.graphQuery` runs it outside any shape catalog; no catalog is resolved for it,
   * so the check resolves the same store. A store's refusal answers with its code (see
   * `graphQueryCallError`).
   */
  @callable('public')
  async graphQuery(json: any) {
    if (json && typeof json === 'object' && 'txId' in json) {
      await abandonTransactionOf(json);
      throw new ServerCallError(400, 'A graph query does not run in a transaction');
    }
    const query = toGraphQuery(json);
    await authorizeGraphQuery(json, query, 'graphQuery');
    if (!query) throw new ServerCallError(400, 'Invalid graph query');
    try {
      return await LinkedStorage.graphQuery(query);
    } catch (err) {
      throw graphQueryCallError(err);
    }
  }
}
