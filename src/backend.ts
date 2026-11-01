import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { callable } from '@_linked/server-utils/utils/callable';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { LocalFileStore } from './shapes/filestores/LocalFileStore.js';
import {
  authorizeGenericQuery,
  authorizeGraphQuery,
  graphQueryCallError,
  resolveQueryCatalog,
  toGraphQuery,
  toQueryBuilder,
} from './utils/queryPlane.js';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { getCallContext } from '@_linked/server-utils/utils/CallContext';
import { txIdOf } from '@_linked/core/queries/transactionQuery';
import { supportsTransactions, type Transaction } from '@_linked/core/utils/Transaction';
import { isLinkedError } from '@_linked/core/utils/linkedError';
import {
  ForwardedTransactions,
  TransactionNotYoursError,
  TransactionUnknownError,
  TransactionUnsupportedError,
} from './utils/forwardedTransactions.js';
import path from 'path';
import fs from 'fs/promises';

/** The transactions this server holds for its callers (see `utils/forwardedTransactions`). */
const transactions = new ForwardedTransactions();

/**
 * Whether every dataset `LinkedStorage` routes to holds store transactions: only then does this
 * server begin one, so no query of a transaction can reach a store that would run it outside.
 */
function storesHoldTransactions(): boolean {
  const datasets = [...LinkedStorage.getDatasets()];
  if (!datasets.length) return false;
  return datasets.every((dataset) => {
    try {
      return supportsTransactions(dataset);
    } catch {
      return false;
    }
  });
}

function assertStoresHoldTransactions(): void {
  if (storesHoldTransactions()) return;
  throw new TransactionUnsupportedError(
    "The stores of this server do not all declare 'transactions' in `supports`, so it holds no " +
      'transactions; a query of one is refused rather than run outside it.'
  );
}

/**
 * Who a transaction is bound to: the session's user account in an HTTP call (a session is
 * required, as for a write without an access rule), `system` for work with no request behind it.
 */
function transactionCaller(): string {
  const ctx = getCallContext();
  if (!ctx || ctx.kind !== 'http') return 'system';
  const id = ctx.request?.linkedAuth?.userAccount?.id;
  if (typeof id !== 'string' || !id) throw new ServerCallError(401, 'Authentication required');
  return `user:${id}`;
}

/** A transaction refusal as the answer the caller gets (`{error, code}`); anything else as is. */
function transactionCallError(err: unknown): unknown {
  const status = isLinkedError(err, TransactionUnsupportedError)
    ? 501
    : isLinkedError(err, TransactionUnknownError)
      ? 409
      : isLinkedError(err, TransactionNotYoursError)
        ? 403
        : undefined;
  if (status === undefined) return err;
  const error = err as Error & { code: string };
  return Object.assign(new ServerCallError(status, error.message, { cause: err }), { code: error.code });
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
   * Run a query that carries a txId in its transaction: the caller's own, checked against the
   * store rules as if it were sent alone. A refusal or a failure rolls the transaction back.
   */
  private async inTransaction<R>(
    query: object,
    authorize: () => Promise<void>,
    run: (tx: Transaction, query: any) => Promise<R>
  ): Promise<R> {
    try {
      return await transactions.query(
        query,
        transactionCaller(),
        async () => {
          assertStoresHoldTransactions();
          await authorize();
        },
        run
      );
    } catch (err) {
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

  @callable('public')
  async selectQuery(json: any) {
    const query = toQueryBuilder(json, await resolveQueryCatalog(json));
    const authorize = () => authorizeGenericQuery('select', json, query, 'selectQuery');
    if (txIdOf(query)) return this.inTransaction(query, authorize, (tx, q) => tx.selectQuery(q));
    await authorize();
    return LinkedStorage.selectQuery(query);
  }

  @callable('public')
  async askQuery(json: any) {
    const query = toQueryBuilder(json, await resolveQueryCatalog(json));
    const authorize = () => authorizeGenericQuery('ask', json, query, 'askQuery');
    if (txIdOf(query)) return this.inTransaction(query, authorize, (tx, q) => tx.askQuery(q));
    await authorize();
    return LinkedStorage.askQuery(query);
  }

  @callable('public')
  async updateQuery(json: any) {
    const query = toQueryBuilder(json, await resolveQueryCatalog(json));
    const authorize = () => authorizeGenericQuery('update', json, query, 'updateQuery');
    if (txIdOf(query)) return this.inTransaction(query, authorize, (tx, q) => tx.updateQuery(q));
    await authorize();
    return LinkedStorage.updateQuery(query);
  }

  @callable('public')
  async createQuery(json: any) {
    const query = toQueryBuilder(json, await resolveQueryCatalog(json));
    const authorize = () => authorizeGenericQuery('create', json, query, 'createQuery');
    if (txIdOf(query)) return this.inTransaction(query, authorize, (tx, q) => tx.createQuery(q));
    await authorize();
    return LinkedStorage.createQuery(query);
  }

  @callable('public')
  async deleteQuery(json: any) {
    const query = toQueryBuilder(json, await resolveQueryCatalog(json));
    const authorize = () => authorizeGenericQuery('delete', json, query, 'deleteQuery');
    if (txIdOf(query)) return this.inTransaction(query, authorize, (tx, q) => tx.deleteQuery(q));
    await authorize();
    return LinkedStorage.deleteQuery(query);
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
