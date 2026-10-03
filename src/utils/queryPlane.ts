/**
 * Authorization for the generic query plane: the endpoints that run a query the
 * client built (`LincdServerBackendProvider.*Query` behind
 * `/call/@_linked/server/*Query`, and `LincdAPI` `post_*` behind `/api/*`).
 *
 * The rules are declared per store in the app's storage config
 * (`linked.backend.storage.js`) with `withAccess` from
 * `@_linked/server-utils/utils/QueryAccess`; see `checkQueryAccess` there for
 * how a query is mapped to stores and the order the checks apply in. This
 * module turns the incoming query into the builder the store runs and the IR
 * the rules read.
 *
 * INTERIM: that per-store access model needs to be revised and rethought from
 * the ground up (see QueryAccess).
 */
import { fromJSON } from '@_linked/core';
import { lower } from '@_linked/core/queries/lower';
import {
  checkQueryAccess,
  type QueryOperation,
} from '@_linked/server-utils/utils/QueryAccess';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { getRawQueriesMode } from './rawQueries.js';
import { getRpcExposureMode } from './rpcExposure.js';

/** The DSL-JSON tag of a query-context reference (`CONTEXT_REF_KEY` in core). */
const CONTEXT_REF_KEY = '@ctx';

/**
 * Whether DSL-JSON carries a query-context reference (`{"@ctx": name}`) in any
 * position: a select or count subject, an update target, a delete id, a
 * where-clause operand or a mutation field value. Every DSL-JSON decoder in
 * core reads a context reference from this one key.
 */
export function containsContextRef(json: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [json];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(value, CONTEXT_REF_KEY)) return true;
    for (const key of Object.keys(value)) stack.push((value as any)[key]);
  }
  return false;
}

/**
 * A rehydrated query builder from the DSL-JSON a client sent. The result is
 * what the store runs, so the access check and the store see the same query.
 * A body that is not a query answers 400.
 *
 * A query-context reference (`{"@ctx": "user"}`) also answers 400. Core
 * resolves one at lowering time against a process-wide context map, which on a
 * server holds whatever some code last set there, not the caller's identity,
 * and lowering runs twice (once for the access check, once in the store), so
 * the two could even resolve it differently. A query built from client JSON
 * names its nodes by id.
 *
 * Without context references, lowering a rehydrated builder is a pure function
 * of the builder (closed and never mutated after `fromJSON`) and the shape
 * registry: the IR `authorizeGenericQuery` checks is the IR the store lowers
 * from the same builder.
 */
export function toQueryBuilder(query: any): any {
  // A live builder passed by backend code (never a plain object from JSON).
  if (
    query &&
    typeof query === 'object' &&
    Object.getPrototypeOf(query) !== Object.prototype &&
    typeof query.__queryKind === 'string'
  ) {
    return query;
  }
  if (containsContextRef(query)) {
    throw new ServerCallError(
      400,
      'Query context references (@ctx) are not accepted by the generic query endpoints'
    );
  }
  try {
    const builder = fromJSON(query);
    if (!builder || typeof builder !== 'object') throw new Error('not a query');
    return builder;
  } catch {
    throw new ServerCallError(400, 'Invalid query');
  }
}

/** The lowered IR of a query, or `undefined` when it cannot be lowered (refused). */
export function lowerForAccessCheck(builder: any): unknown {
  try {
    return lower(builder);
  } catch {
    return undefined;
  }
}

/**
 * Check `builder` (rehydrated from `query` with `toQueryBuilder`) against the
 * store access rules. Throws a `ServerCallError` (400/401/403) when the current
 * call may not run it; the caller then hands the same builder to the store.
 *
 * Deliberately returns nothing: a query builder is a thenable, so resolving an
 * async function with one would run it.
 */
export async function authorizeGenericQuery(
  operation: QueryOperation,
  query: unknown,
  builder: any,
  endpoint: string
): Promise<void> {
  await checkQueryAccess({
    operation,
    query,
    ir: lowerForAccessCheck(builder),
    mode: getRpcExposureMode(),
    endpoint,
  });
}

/** Check a raw SPARQL query against the `rawQueries` setting (see utils/rawQueries). */
export async function authorizeRawQuery(query: unknown, endpoint: string): Promise<void> {
  if (typeof query !== 'string') {
    throw new ServerCallError(400, 'Invalid query');
  }
  await checkQueryAccess({
    operation: 'select',
    query,
    ir: undefined,
    raw: true,
    rawQueries: getRawQueriesMode(),
    mode: getRpcExposureMode(),
    endpoint,
  });
}
