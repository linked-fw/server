/**
 * The store transactions a forwarder holds for its callers (core report 103, "Forwarding contract").
 *
 * A forwarder (this server's query plane) answers `beginTransaction()` with an id of its own and
 * keeps a core `Transaction` for it. Each later query that carries the id runs in that
 * transaction, which opens a transaction in the store the query routes to at its first query
 * there (and warns, as core does, when a second store is reached). The id is bound to the caller
 * that began it: anyone else presenting it is refused, and the transaction is left as it was.
 *
 * - A query that fails, or that a check refuses, fails the transaction: it is rolled back in
 *   every store and forgotten, so a later `commit` rejects as unknown and `rollback` resolves.
 * - An idle transaction (no query, commit or rollback for `timeoutMs`, default 30 s) is rolled
 *   back and forgotten.
 * - A forwarder holds transactions only when every store it routes to does; it checks that
 *   itself (see `supportsTransactions` in core) before it begins one or runs a query in one.
 */
import { randomUUID } from 'node:crypto';
import { brandLinkedError } from '@_linked/core/utils/linkedError';
import type { Transaction } from '@_linked/core/utils/Transaction';
import { txIdOf } from '@_linked/core/queries/transactionQuery';

/** A transaction was asked of a forwarder whose stores do not all hold transactions. */
export class TransactionUnsupportedError extends Error {
  readonly code = 'transactions-unsupported';
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A txId this forwarder does not hold: never begun here, ended, failed, or expired. */
export class TransactionUnknownError extends Error {
  readonly code = 'transaction-unknown';
  constructor(txId: string) {
    super(`transaction ${txId} is unknown or expired`);
    this.name = new.target.name;
  }
}

/** A txId presented by another caller than the one that began it. */
export class TransactionNotYoursError extends Error {
  readonly code = 'transaction-not-yours';
  constructor(txId: string) {
    super(`transaction ${txId} was begun by another caller`);
    this.name = new.target.name;
  }
}

brandLinkedError(TransactionUnsupportedError, '@_linked/server', 'TransactionUnsupportedError');
brandLinkedError(TransactionUnknownError, '@_linked/server', 'TransactionUnknownError');
brandLinkedError(TransactionNotYoursError, '@_linked/server', 'TransactionNotYoursError');

/** The query a transaction view stands for: core's `inTransaction` view has it as prototype. */
export function withoutTxId<Q extends object>(query: Q): Q {
  if (!Object.prototype.hasOwnProperty.call(query, 'txId')) return query;
  return Object.getPrototypeOf(query) as Q;
}

interface Held {
  tx: Transaction;
  caller: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ForwardedTransactionsOptions {
  /** Idle time after which a transaction is rolled back and forgotten, in ms (default 30 000). */
  timeoutMs?: number;
}

export class ForwardedTransactions {
  private readonly held = new Map<string, Held>();
  private readonly timeoutMs: number;

  constructor(options: ForwardedTransactionsOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** How many transactions are open (for tests and diagnostics). */
  get size(): number {
    return this.held.size;
  }

  /** Hold `tx` for `caller`; answers its id. */
  begin(caller: string, tx: Transaction): string {
    const txId = randomUUID();
    const held: Held = { tx, caller };
    this.held.set(txId, held);
    this.touch(txId, held);
    return txId;
  }

  /**
   * Run `query` (which carries a txId) in its transaction: the caller must be the one that began
   * it; then `check` (the rights of the query, as if it were sent alone) and `run` with the query
   * outside its view. A refusal by `check` and a failure of `run` roll the transaction back.
   */
  async query<R>(
    query: object,
    caller: string,
    check: () => Promise<void> | void,
    run: (tx: Transaction, query: any) => Promise<R>,
  ): Promise<R> {
    const txId = txIdOf(query);
    if (txId === undefined) throw new Error('ForwardedTransactions.query: the query carries no txId');
    const held = this.own(txId, caller);
    this.touch(txId, held);
    try {
      await check();
      return await run(held.tx, withoutTxId(query));
    } catch (err) {
      await this.drop(txId, held, true);
      throw err;
    }
  }

  /** Commit: the caller's own transaction, else refused; unknown or expired rejects. */
  async commit(txId: string, caller: string): Promise<void> {
    const held = this.own(txId, caller);
    await this.drop(txId, held, false);
    await held.tx.commit();
  }

  /** Roll back: the caller's own transaction, else refused; an unknown txId resolves (a no-op). */
  async rollback(txId: string, caller: string): Promise<void> {
    const held = this.held.get(txId);
    if (!held) return;
    if (held.caller !== caller) throw new TransactionNotYoursError(txId);
    await this.drop(txId, held, true);
  }

  /** Roll back and forget every transaction (a forwarder that shuts down). */
  async rollbackAll(): Promise<void> {
    await Promise.all([...this.held].map(([txId, held]) => this.drop(txId, held, true)));
  }

  private own(txId: string, caller: string): Held {
    const held = typeof txId === 'string' ? this.held.get(txId) : undefined;
    if (!held) throw new TransactionUnknownError(String(txId));
    if (held.caller !== caller) throw new TransactionNotYoursError(txId);
    return held;
  }

  private touch(txId: string, held: Held): void {
    if (held.timer) clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      void this.drop(txId, held, true);
    }, this.timeoutMs);
    held.timer.unref?.();
  }

  /** Forget `txId` (once), rolling its transaction back when asked to. */
  private async drop(txId: string, held: Held, rollBack: boolean): Promise<void> {
    if (held.timer) clearTimeout(held.timer);
    if (this.held.get(txId) !== held) return;
    this.held.delete(txId);
    if (!rollBack) return;
    try {
      await held.tx.rollback();
    } catch (err) {
      // Committed or failed already: nothing to roll back.
      if (held.tx.state === 'open') console.error(`[linked] rolling back transaction ${txId} failed:`, err);
    }
  }
}
