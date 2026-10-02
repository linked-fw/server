/**
 * Authorization for the generic query plane: the endpoints that run a query the
 * client built (`LincdServerBackendProvider.*Query` behind
 * `/call/@_linked/server/*Query`, and `LincdAPI` `post_*` behind `/api/*`).
 *
 * The rules themselves (protected shapes, authorizers) are registered through
 * `@_linked/server-utils/utils/QueryAccess`; see `checkQueryAccess` there for the
 * order they apply in. This module turns the incoming query into the IR those
 * rules read.
 */
import { fromJSON } from '@_linked/core';
import { lower } from '@_linked/core/queries/lower';
import {
  checkQueryAccess,
  type QueryOperation,
} from '@_linked/server-utils/utils/QueryAccess';
import { getRpcExposureMode } from './rpcExposure.js';

/** A rehydrated query builder, from either a builder or its DSL-JSON. */
export function toQueryBuilder(query: any): any {
  if (query && typeof query === 'object' && typeof query.__queryKind === 'string') {
    return query;
  }
  return fromJSON(query);
}

/**
 * The lowered IR of a query, or `undefined` when it cannot be lowered. An
 * unlowerable query is treated as unanalysable rather than failing here: the
 * store still reports the real error when it runs it.
 */
export function lowerForAccessCheck(builder: any): unknown {
  try {
    return lower(builder);
  } catch {
    return undefined;
  }
}

/** Throws (401/403 `ServerCallError`) when the current call may not run `query`. */
export async function authorizeGenericQuery(
  operation: QueryOperation,
  query: unknown,
  builder: any,
  endpoint: string
): Promise<void> {
  await checkQueryAccess({
    operation,
    query,
    ir: builder === undefined ? undefined : lowerForAccessCheck(builder),
    mode: getRpcExposureMode(),
    endpoint,
  });
}
