/**
 * The store transactions this server's generic query plane holds (see `forwardedTransactions`
 * and the provider in `backend.ts`): one registry per process, who a transaction is bound to,
 * and how its refusals are answered. Server-only.
 */
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { supportsTransactions } from '@_linked/core/utils/Transaction';
import { isLinkedError } from '@_linked/core/utils/linkedError';
import { getCallContext } from '@_linked/server-utils/utils/CallContext';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import {
  ForwardedTransactions,
  TransactionNotYoursError,
  TransactionUnknownError,
  TransactionUnsupportedError,
} from './forwardedTransactions.js';

/** The transactions this server holds for its callers (see `utils/forwardedTransactions`). */
export const transactions = new ForwardedTransactions();

/**
 * Whether every dataset `LinkedStorage` routes to holds store transactions: only then does this
 * server begin one, so no query of a transaction can reach a store that would run it outside.
 */
export function storesHoldTransactions(): boolean {
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

export function assertStoresHoldTransactions(): void {
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
export function transactionCaller(): string {
  const ctx = getCallContext();
  if (!ctx || ctx.kind !== 'http') return 'system';
  const id = ctx.request?.linkedAuth?.userAccount?.id;
  if (typeof id !== 'string' || !id) throw new ServerCallError(401, 'Authentication required');
  return `user:${id}`;
}

/** A transaction refusal as the answer the caller gets (`{error, code}`); anything else as is. */
export function transactionCallError(err: unknown): unknown {
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

/**
 * Roll back the transaction a refused request names (`txId` in its body), when it is the
 * caller's own: a query refused before it ran in its transaction must not leave it open.
 * Nothing happens for anyone else's, or an unknown one.
 */
export async function abandonTransactionOf(json: unknown): Promise<void> {
  const txId = (json as { txId?: unknown } | null)?.txId;
  if (typeof txId !== 'string' || !txId) return;
  try {
    await transactions.rollback(txId, transactionCaller());
  } catch {
    // another caller's, or no session: not ours to end
  }
}

