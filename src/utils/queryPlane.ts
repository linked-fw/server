/**
 * Authorization for the generic query plane: the endpoints that run a query the
 * client built (`LincdServerBackendProvider.*Query` behind
 * `/call/@_linked/server/*Query`, and `LincdAPI` `post_*` behind `/api/*`).
 *
 * The rules themselves (protected shapes, authorizers) are registered through
 * `@_linked/server-utils/utils/QueryAccess`; see `checkQueryAccess` there for the
 * order they apply in. This module turns the incoming query into the builder the
 * store runs and the IR the rules read, and answers the rules' protected-node
 * lookup with a SPARQL `ASK` against the store the mutation routes to.
 */
import { fromJSON } from '@_linked/core';
import { lower } from '@_linked/core/queries/lower';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { getShapeClass } from '@_linked/core/utils/ShapeClass';
import {
  checkQueryAccess,
  type ProtectedNodeCheck,
  type ProtectedNodeProbe,
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

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

/** `<iri>`, refusing anything that is not a plain absolute IRI. */
function iriTerm(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\\u0000-\u001f\u007f]*$/.test(value)
  ) {
    throw new ServerCallError(400, 'Invalid node id');
  }
  return `<${value}>`;
}

/**
 * The `ASK` that answers a protected-node check: is any node the mutation would
 * write or delete typed with a protected class, or a subclass of one?
 * `undefined` when there is nothing to ask.
 */
export function protectedNodeAsk(check: ProtectedNodeCheck): string | undefined {
  if (!check.classes.length) return undefined;
  const branches: string[] = [];
  const owned = check.containsPredicates.length
    ? '(' + check.containsPredicates.map(iriTerm).join('|') + ')+'
    : undefined;
  if (check.ids.length) {
    branches.push(`{ VALUES ?n { ${check.ids.map(iriTerm).join(' ')} } }`);
  }
  if (owned && check.ownerIds.length) {
    branches.push(
      `{ VALUES ?owner { ${check.ownerIds.map(iriTerm).join(' ')} } ?owner ${owned} ?n . }`
    );
  }
  for (const cls of check.scanClasses) {
    branches.push(`{ ?n <${RDF_TYPE}> ${iriTerm(cls)} . }`);
    if (owned) branches.push(`{ ?s <${RDF_TYPE}> ${iriTerm(cls)} . ?s ${owned} ?n . }`);
  }
  if (!branches.length) return undefined;
  return (
    `ASK WHERE {\n  ${branches.join('\n  UNION ')}\n` +
    `  ?n <${RDF_TYPE}> ?t .\n` +
    `  VALUES ?c { ${check.classes.map(iriTerm).join(' ')} }\n` +
    `  ?t <${RDFS_SUBCLASS_OF}>* ?c .\n}`
  );
}

/**
 * The default protected-node lookup: one `ASK` on the dataset the mutation's
 * shape routes to (run in the current call's context, so a routing dataset
 * resolves it exactly as it will resolve the mutation). A dataset that cannot
 * run SPARQL (`rawQuery`) cannot be checked, and the mutation is refused.
 */
export const askProtectedNodes: ProtectedNodeProbe = async (check) => {
  const sparql = protectedNodeAsk(check);
  if (!sparql) return false;
  let shapeClass: any;
  try {
    shapeClass = getShapeClass(check.shape as any);
  } catch {
    shapeClass = undefined;
  }
  const dataset: any =
    LinkedStorage.getDatasetForShapeClass(shapeClass) ?? LinkedStorage.getDefaultDataset();
  if (!dataset || typeof dataset.rawQuery !== 'function') {
    throw new Error(
      `the dataset for ${check.shape} cannot run SPARQL, so the nodes this mutation writes cannot be checked`
    );
  }
  const json = await dataset.rawQuery(sparql);
  if (typeof json?.boolean !== 'boolean') {
    throw new Error('the dataset did not answer the ASK with a boolean');
  }
  return json.boolean;
};

let probe: ProtectedNodeProbe = askProtectedNodes;

/**
 * Replace the protected-node lookup (see `checkQueryAccess`): an app whose
 * protected nodes live in a known store can answer it there. Pass `undefined`
 * to restore the default `ASK`.
 */
export function setProtectedNodeProbe(fn: ProtectedNodeProbe | undefined): void {
  if (fn !== undefined && typeof fn !== 'function') {
    throw new TypeError('setProtectedNodeProbe: expected a function');
  }
  probe = fn ?? askProtectedNodes;
}

/**
 * Check `builder` (rehydrated from `query` with `toQueryBuilder`) against the
 * generic-plane rules. Throws a `ServerCallError` (400/401/403) when the current
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
    probeProtectedNodes: probe,
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
