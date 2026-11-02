import { readKindOf, type ReadQuery, type ReadResult } from '@_linked/core/queries/readQuery';
import type { SelectQuery } from '@_linked/core/queries/SelectQuery';
import type { CountQuery } from '@_linked/core/queries/CountQuery';
import type { AskQuery } from '@_linked/core/queries/AskQuery';

/** What a test dataset answers, per kind of read. A kind without a handler is refused. */
export type ReadHandlers = {
  /** A select and a count (`readKindOf` tells them apart). */
  select?: (query: SelectQuery | CountQuery) => unknown;
  ask?: (query: AskQuery) => unknown;
};

/**
 * A test dataset's `readQuery`, from one handler per kind: `{readQuery: readQueryOf({select, ask})}`.
 * A dataset that answers asks itself also declares `'ask'` in `supports` (else core's dispatch
 * sends its asks as selects).
 */
export function readQueryOf(handlers: ReadHandlers) {
  return async <Q extends ReadQuery>(query: Q): Promise<ReadResult<Q>> => {
    const kind = readKindOf(query);
    const handler =
      kind === 'select' || kind === 'count' ? handlers.select : kind === 'ask' ? handlers.ask : undefined;
    if (!handler) throw new Error(`This test dataset does not answer a ${kind} read.`);
    return (await (handler as (query: ReadQuery) => unknown)(query)) as ReadResult<Q>;
  };
}

/**
 * A stand-in for a live query that only serializes: `RemoteDataset` reads nothing from a query
 * but its kind and `toJSON()`. The kind follows the DSL-JSON `op` (absent: a select).
 */
export function queryJson(json: Record<string, unknown>): any {
  const op = json.op;
  const __queryKind = op === 'count' || op === 'ask' ? op : op === undefined || op === 'select' ? 'select' : op;
  return { __queryKind, toJSON: () => json };
}
