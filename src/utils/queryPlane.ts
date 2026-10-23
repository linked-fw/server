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
 * Graph queries (`graph_create`, `graph_replace`, `graph_patch`, `graph_drop`) arrive as plain
 * data on `/call/@_linked/server/graphQuery`: {@link toGraphQuery} checks the JSON, the store's
 * `graph` rule decides ({@link authorizeGraphQuery}), and a refusal of the store goes back with
 * its code ({@link graphQueryCallError}).
 *
 * The host can supply the shape catalog a request's query is decoded in
 * (`setQueryCatalogResolver`), so one server can resolve the same shape IRI
 * differently per request (for example per project branch).
 *
 * INTERIM: that per-store access model needs to be revised and rethought from
 * the ground up (see QueryAccess).
 */
import { fromJSON } from '@_linked/core';
import {
  isGraphQueryError,
  parseGraphQuery,
  type GraphQuery,
  type GraphQueryErrorCode,
} from '@_linked/core/queries/graphQuery';
import { lower } from '@_linked/core/queries/lower';
import type { ShapeCatalog } from '@_linked/core/utils/ShapeCatalog';
import {
  checkQueryAccess,
  type QueryOperation,
} from '@_linked/server-utils/utils/QueryAccess';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { getRawQueriesMode } from './rawQueries.js';
import { getRpcExposureMode } from './rpcExposure.js';
import { sharedState } from '@_linked/core/utils/sharedState';

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
 * Supplies the shape catalog a generic query request is decoded in, from the
 * DSL-JSON the client sent (the request context is available through the
 * host's own means, e.g. `getCallContext`). `undefined` means the global
 * shape registry.
 */
export type QueryCatalogResolver = (
  query: unknown
) => ShapeCatalog | undefined | Promise<ShapeCatalog | undefined>;

/**
 * The host's resolver, shared by every copy of this module in the process: the host sets it
 * through one copy, and the query endpoint served by another must use it rather than decode in
 * the global registry. See https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md.
 */
const queryPlaneState = sharedState('@_linked/server', 'queryPlane', () => ({
  catalogResolver: undefined as QueryCatalogResolver | undefined,
}));

/**
 * Set (or, with `undefined`, clear) the host's catalog resolver for the
 * generic query endpoints. Without one, every query decodes in the global
 * shape registry.
 */
export function setQueryCatalogResolver(resolver: QueryCatalogResolver | undefined): void {
  queryPlaneState.catalogResolver = resolver;
}

/** A live builder passed by backend code (never a plain object from JSON). */
function isLiveBuilder(query: any): boolean {
  return (
    !!query &&
    typeof query === 'object' &&
    Object.getPrototypeOf(query) !== Object.prototype &&
    typeof query.__queryKind === 'string'
  );
}

/**
 * The catalog `query` is decoded in: the host resolver's answer, or
 * `undefined` (the global registry) without a resolver. A live builder already
 * carries its catalog, so the resolver is not asked for it.
 *
 * A `ServerCallError` the resolver throws is passed on as is (the host chose
 * the status); any other failure is logged and answers 500.
 */
export async function resolveQueryCatalog(query: unknown): Promise<ShapeCatalog | undefined> {
  const resolver = queryPlaneState.catalogResolver;
  if (!resolver || isLiveBuilder(query)) return undefined;
  try {
    return await resolver(query);
  } catch (error) {
    if (ServerCallError.is(error)) throw error;
    console.error('[queryPlane] the shape catalog resolver failed:', error);
    throw new ServerCallError(500, 'Shape catalog unavailable');
  }
}

/**
 * A rehydrated query builder from the DSL-JSON a client sent, decoded in
 * `catalog` (`undefined`: the global registry, whatever catalog is active;
 * see `resolveQueryCatalog`). The builder keeps that catalog, so
 * the access-check lowering and the store's lowering both resolve against it.
 * The result is what the store runs, so the access check and the store see
 * the same query. A body that is not a query answers 400.
 *
 * A query-context reference (`{"@ctx": "user"}`) also answers 400. Core
 * resolves one at lowering time against a process-wide context map, which on a
 * server holds whatever some code last set there, not the caller's identity,
 * and lowering runs twice (once for the access check, once in the store), so
 * the two could even resolve it differently. A query built from client JSON
 * names its nodes by id.
 *
 * Without context references, lowering a rehydrated builder is a pure function
 * of the builder (closed and never mutated after `fromJSON`) and its shape
 * catalog: the IR `authorizeGenericQuery` checks is the IR the store lowers
 * from the same builder.
 */
export function toQueryBuilder(query: unknown, catalog?: ShapeCatalog): any {
  if (isLiveBuilder(query)) return query;
  if (containsContextRef(query)) {
    throw new ServerCallError(
      400,
      'Query context references (@ctx) are not accepted by the generic query endpoints'
    );
  }
  try {
    const builder = fromJSON(query as any, { catalog });
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

/**
 * The graph query `json` describes, checked with core's `parseGraphQuery`; `undefined` when it is
 * not a valid graph query (the access check then refuses it with 400).
 */
export function toGraphQuery(json: unknown): GraphQuery | undefined {
  try {
    return parseGraphQuery(json);
  } catch {
    return undefined;
  }
}

/**
 * Check a graph query against the `graph` rule of the store `LinkedStorage.graphQuery` routes its
 * record class to (`QueryAccess`, operation `graph`): no rule, or `'none'`, refuses it (403, 401
 * without a session); a malformed one answers 400. `ir` is {@link toGraphQuery}'s result. No
 * catalog is resolved for a graph query (its record shapes are core's built-ins), so the check
 * resolves the store in the global registry, where `LinkedStorage.graphQuery` then runs it.
 */
export async function authorizeGraphQuery(
  query: unknown,
  ir: GraphQuery | undefined,
  endpoint: string
): Promise<void> {
  await checkQueryAccess({
    operation: 'graph',
    query,
    ir,
    mode: getRpcExposureMode(),
    endpoint,
  });
}

/** The HTTP status each graph query refusal is answered with. */
const GRAPH_REFUSAL_STATUS: Record<GraphQueryErrorCode, number> = {
  'unsupported-query-kind': 501,
  'graph-name-read-only': 400,
  'graph-not-registered': 409,
  'graph-exists': 409,
};

/**
 * A store's graph query refusal (`GraphQueryError`) as the answer the caller gets: a
 * `ServerCallError` with the refusal's status and message and its `code`, which the call route
 * sends as `{error, code}` (`RemoteDataset` turns it back into a `GraphQueryError`). Any other
 * error is returned as is.
 */
export function graphQueryCallError(err: unknown): unknown {
  if (!isGraphQueryError(err)) return err;
  const status = GRAPH_REFUSAL_STATUS[err.code] ?? 400;
  return Object.assign(new ServerCallError(status, err.message, { cause: err }), { code: err.code });
}
