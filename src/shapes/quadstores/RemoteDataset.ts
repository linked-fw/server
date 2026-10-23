import { packageName } from '../../package.js';
import { brandLinkedError } from '@_linked/core/utils/linkedError';
import { Server } from '@_linked/server-utils/utils/Server';
import type { CallContext } from '@_linked/server-utils/utils/CallContext';
import type { IDataset } from '@_linked/core/interfaces/IDataset';
import type { SelectQuery } from '@_linked/core/queries/SelectQuery';
import type { CountQuery } from '@_linked/core/queries/CountQuery';
import type { AskQuery } from '@_linked/core/queries/AskQuery';
import type { UpdateQuery } from '@_linked/core/queries/UpdateQuery';
import type { CreateQuery } from '@_linked/core/queries/CreateQuery';
import type {
  DeleteQuery,
  DeleteResponse,
} from '@_linked/core/queries/DeleteQuery';
import type {
  SelectResult,
  UpdateResult,
  CreateResult,
  GraphQuery,
  GraphResult,
} from '@_linked/core/queries/IntermediateRepresentation';
import {
  GraphQueryError,
  isGraphQueryError,
  unsupportedGraphQuery,
  type GraphQueryErrorCode,
} from '@_linked/core/queries/graphQuery';
import {
  invalidateGraphRegistry,
  noteGraphQuery,
  readGraphRegistry,
  type GraphRegistryRow,
} from '@_linked/core/utils/graphRegistryCache';
import { graphs } from '@_linked/core/ontologies/graphs';
import { OntologyGraph, ShapesGraph } from '@_linked/core/shapes/NamedGraph';

/**
 * Constructor argument for `new RemoteDataset(config)`: the `config` object of a
 * `linked.{frontend,backend}.datasets.json` entry, passed verbatim.
 */
export interface RemoteDatasetConfig {
  /**
   * Base URL of the data server, e.g. `http://localhost:4040/gateway`; routes are appended
   * to it. Without it, queries go to this process's own backend through `Server.call`.
   * Present but empty is an error, never the no-url form.
   */
  url?: string;
  /** Sent as `Authorization: Bearer <token>` when set and `url` is set. */
  token?: string;
  /** Stable name; becomes the suffix of the store URI: ${DATA_ROOT}/backend-api-store/<name>. */
  name?: string;
  /** Or pass a fully-qualified URI directly. */
  id?: string;
  /**
   * In the url form, send the signed-in user's WebID of the current call as
   * `x-linked-end-user` (see {@link END_USER_HEADER}). Default true; `false` (or the
   * string `'false'`, as an interpolated config gives it) turns it off.
   */
  forwardEndUser?: boolean | string;
}

/**
 * The header the url form sends with a query made while a signed-in user's HTTP request is
 * being answered: that user's WebID. The data server decides what to do with it; the bearer
 * token still decides which data the store reaches.
 */
export const END_USER_HEADER = 'x-linked-end-user';

// The store `@_linked/server-utils/utils/CallContext` keeps the call context in, shared on
// `globalThis` under this key. Read here instead of importing that module: it imports
// `node:async_hooks`, and this store also runs in the browser (the no-url form). In a browser,
// and in a server before any call ran, the key is unset and there is no context.
const CALL_CONTEXT_KEY = Symbol.for('@_linked/server-utils:callContext');

function currentCallContext(): CallContext | undefined {
  const store = (globalThis as Record<symbol, { getStore?: () => unknown } | undefined>)[CALL_CONTEXT_KEY];
  return typeof store?.getStore === 'function' ? (store.getStore() as CallContext | undefined) : undefined;
}

/**
 * The WebID of the signed-in user behind the current call: the http context's
 * `request.linkedAuth.userAccount.accountOf.id`. Undefined in a system context
 * (`runAsSystem`), outside any call, and for a request without a session.
 */
export function currentEndUserWebId(): string | undefined {
  const ctx = currentCallContext();
  if (!ctx || ctx.kind !== 'http') return undefined;
  const webId = ctx.request?.linkedAuth?.userAccount?.accountOf?.id;
  return typeof webId === 'string' && webId ? webId : undefined;
}

/**
 * A failed call to the data server at `url`. `status` is the HTTP status (0 when no HTTP
 * answer came back); `code` is the error body's `code` when the server sent one.
 */
export class RemoteDatasetError extends Error {
  /** The data server base url ('' when the configured url is empty). */
  readonly url: string;
  /** The HTTP status; 0 = no HTTP answer. */
  readonly status: number;
  /** The error body's `code`, when the server sent one. */
  readonly code?: string;

  constructor(message: string, url: string, status: number, code?: string) {
    super(message);
    this.name = new.target.name;
    this.url = url;
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/**
 * Nothing at `url` speaks the query wire: no HTTP answer, an empty url, or (on `ping`) an
 * answer that is not the server's. A boot that gets this should stop.
 */
export class RemoteDatasetUnreachableError extends RemoteDatasetError {}

/** The data server answered 401 or 403: it refused this dataset's token. */
export class RemoteDatasetUnauthorizedError extends RemoteDatasetError {}

// Branded, so `isLinkedError(err, RemoteDatasetUnreachableError)` from `@_linked/core` matches an
// error thrown by another copy of this module, where `instanceof` does not. See
// https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md.
brandLinkedError(RemoteDatasetError, '@_linked/server', 'RemoteDatasetError');
brandLinkedError(RemoteDatasetUnreachableError, '@_linked/server', 'RemoteDatasetUnreachableError');
brandLinkedError(RemoteDatasetUnauthorizedError, '@_linked/server', 'RemoteDatasetUnauthorizedError');

/**
 * What the data server's `ping` answered, as is. The generic `@_linked/server` ping answers
 * `{ok: true}`; a gateway may add fields that say which dataset it serves, such as
 * `{ok, projectId, branchName, dataset, forked}`. A body that is not a JSON object reads as `{}`.
 */
export type RemoteDatasetPingInfo = Readonly<Record<string, unknown>>;

type Method =
  | 'ping'
  | 'selectQuery'
  | 'askQuery'
  | 'updateQuery'
  | 'createQuery'
  | 'deleteQuery'
  | 'graphQuery';

/** The refusal codes a data server sends back for a graph query (`{error, code}`). */
const GRAPH_REFUSAL_CODES: ReadonlySet<string> = new Set<GraphQueryErrorCode>([
  'unsupported-query-kind',
  'graph-not-registered',
  'graph-name-read-only',
  'graph-exists',
]);

/**
 * A failed graph query as the caller expects it: a {@link GraphQueryError} when the data server
 * refused it with one of the graph refusal codes, or when it has no graph method at all (404 or
 * 501 without any code: an older server or gateway), which reads as `unsupported-query-kind`
 * so the ontology sync falls back to the default graph. Anything else is passed on as is.
 */
function graphQueryFailure(err: unknown, query: GraphQuery): unknown {
  if (isGraphQueryError(err)) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  let refusal: GraphQueryError | undefined;
  if (typeof code === 'string' && GRAPH_REFUSAL_CODES.has(code)) {
    refusal = new GraphQueryError(code as GraphQueryErrorCode, message, query.graph);
  } else if (code === undefined) {
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 404 || status === 501) refusal = unsupportedGraphQuery(query, message);
  }
  if (!refusal) return err;
  (refusal as { cause?: unknown }).cause = err;
  return refusal;
}

/** The portable names a remote store expands from its own registry cache, with their record class. */
const REGISTRY_EXPANDED: ReadonlyMap<string, string> = new Map([
  [graphs.allOntologies, OntologyGraph.targetClass.id],
  [graphs.allShapes, ShapesGraph.targetClass.id],
]);

let nextRegistryKey = 0;

/** On `ping`, these statuses mean nothing at that url serves the query wire. */
const PING_UNREACHABLE_STATUSES = new Set([404, 501, 502, 503, 504]);

/**
 * An {@link IDataset} whose queries are answered by a linked server.
 *
 * - **Without `url`** the server is this app's own backend: every query goes through
 *   `Server.call`'s package form (`/call/@_linked/server/<method>` with a body of `{args}`),
 *   and on a backend `Server`'s local shortcut answers it in process. This is the store a
 *   browser uses to talk to its backend.
 * - **With `url`** the server is a remote data server: every query posts
 *   `{"args": [query.toJSON()]}` to `{url}/call/@_linked/server/<method>` with the bearer
 *   `token`, through `fetch`, never through `Server` (whose local shortcut would answer the
 *   app's own provider) and never retried (a retried write could apply twice). `init()` asks
 *   the server's `ping` and throws {@link RemoteDatasetUnreachableError} or
 *   {@link RemoteDatasetUnauthorizedError} when it cannot be used.
 *
 * A store is not a Shape: it addresses the backend by package name, so nothing about the
 * store instance crosses the wire. Query routing is decided by the query's shape.
 *
 * `LinkedStorage.setDefaultDataset` calls `init()` without awaiting it, so a boot that must
 * fail loudly awaits `init()` itself first; a successful `init()` is memoized, and resolves
 * the ping body (also readable as `info`), so a boot can log which dataset the server serves.
 */
export class RemoteDataset implements IDataset {
  /**
   * Kept so the config form is still accepted and a store can be named; it is not an
   * addressing mechanism, nothing transmits or resolves it.
   */
  readonly id?: string;
  /** The data server base url, trailing slashes trimmed; undefined in the no-url form. */
  readonly url?: string;
  private readonly token?: string;
  /** Whether the url form sends {@link END_USER_HEADER}; see `RemoteDatasetConfig.forwardEndUser`. */
  readonly forwardEndUser: boolean = true;
  private initialized?: Promise<RemoteDatasetPingInfo | undefined>;
  private pingInfo?: RemoteDatasetPingInfo;
  private readonly instanceRegistryKey = `remote-dataset:${nextRegistryKey++}`;
  private warnedRegistryRead = false;

  constructor(config?: RemoteDatasetConfig | string) {
    if (!config) return;
    if (typeof config === 'string') {
      this.id = `${process.env.DATA_ROOT}/backend-api-store/${config}`;
      return;
    }
    if (typeof config.url === 'string') {
      this.url = config.url.trim().replace(/\/+$/, '');
      const token = typeof config.token === 'string' ? config.token.trim() : '';
      if (token) this.token = token;
    }
    if (config.forwardEndUser === false || config.forwardEndUser === 'false') {
      this.forwardEndUser = false;
    }
    if (config.id) {
      this.id = config.id;
      return;
    }
    if (config.name) {
      this.id = `${process.env.DATA_ROOT}/backend-api-store/${config.name}`;
    }
  }

  /**
   * The body of the last successful `ping` (see {@link init}); undefined before one, and
   * always in the no-url form.
   */
  get info(): RemoteDatasetPingInfo | undefined {
    return this.pingInfo;
  }

  /**
   * In the url form, asks the server's `ping` and resolves its body (also kept as
   * {@link info}); resolves undefined in the no-url form.
   */
  init(): Promise<RemoteDatasetPingInfo | undefined> {
    // No initialization needed when queries are routed to the app's own backend.
    if (this.url === undefined) return Promise.resolve(undefined);
    if (!this.initialized) {
      this.initialized = this.post('ping', []).then(
        (body) => {
          const info: RemoteDatasetPingInfo = Object.freeze(
            body && typeof body === 'object' && !Array.isArray(body)
              ? { ...(body as Record<string, unknown>) }
              : {},
          );
          this.pingInfo = info;
          return info;
        },
        (err) => {
          // Not memoized: the next init() asks again.
          this.initialized = undefined;
          throw err;
        },
      );
    }
    return this.initialized;
  }

  // Queries serialize to DSL-JSON for the wire: the live (closed) query can't cross a call
  // as-is, so we ship `toJSON()` and the server's generic provider rehydrates it with
  // `fromJSON()`.
  async selectQuery(query: SelectQuery | CountQuery): Promise<SelectResult | number> {
    return this.call('selectQuery', await this.withReadGraphs(query.toJSON()));
  }

  async askQuery(query: AskQuery): Promise<boolean> {
    return this.call('askQuery', await this.withReadGraphs(query.toJSON()));
  }

  updateQuery(query: UpdateQuery): Promise<UpdateResult> {
    return this.call('updateQuery', query.toJSON());
  }

  createQuery(query: CreateQuery): Promise<CreateResult> {
    return this.call('createQuery', query.toJSON());
  }

  deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    return this.call('deleteQuery', query.toJSON());
  }

  /**
   * A whole-graph operation (`graph_create`, `graph_replace`, `graph_patch`, `graph_drop`): the
   * query is plain data, so it is sent as is, the same way and with the same headers as every
   * other query. On success this store's registry cache notes it in the same step (a create adds
   * the graph, a drop removes it), so its next `.from(graphs.allOntologies)` read sees the change.
   * A refusal rejects with a `GraphQueryError` (see `graphQueryFailure`): a server or gateway
   * without the method answers `unsupported-query-kind`.
   */
  async graphQuery(query: GraphQuery): Promise<GraphResult> {
    let result: GraphResult;
    try {
      result = await this.call<GraphResult>('graphQuery', query);
    } catch (err) {
      throw graphQueryFailure(err, query);
    }
    if (this.url !== undefined) noteGraphQuery(this.graphRegistryKey(), query);
    return result;
  }

  /**
   * The key this store's graph-registry cache is kept under: the data server's url and the
   * dataset it named in its `ping` answer (CN's gateway answers `{dataset}`), so stores of the
   * same dataset share one entry; else one key per instance. (`POST /admin/graph-registry-changed`
   * drops every entry of the process, whatever its key.)
   */
  protected graphRegistryKey(): string {
    const dataset = this.pingInfo?.dataset;
    return typeof dataset === 'string' && dataset && this.url
      ? `${this.url}#${dataset}`
      : this.instanceRegistryKey;
  }

  /**
   * Drop the cached graph registry of `dataset` (default: this store's, see `graphRegistryKey`):
   * the next read that expands `graphs.allOntologies` re-reads it.
   */
  invalidateGraphRegistry(dataset?: string): void {
    invalidateGraphRegistry(dataset ?? this.graphRegistryKey());
  }

  /**
   * Read the data server's graph registry: the records of the ontology and shapes graphs, by
   * class, through the same query wire (the record shapes read the registry graph themselves).
   */
  protected async loadGraphRegistry(): Promise<GraphRegistryRow[]> {
    const rows: GraphRegistryRow[] = [];
    const kinds = [OntologyGraph, ShapesGraph] as const;
    const results = await Promise.all(kinds.map((kind) => kind.select().exec(this)));
    results.forEach((records, i) => {
      const recordClass = kinds[i].targetClass.id;
      for (const record of (records as Array<{ id?: unknown }> | null) ?? []) {
        if (typeof record?.id === 'string' && record.id) rows.push({ graph: record.id, recordClass });
      }
    });
    return rows;
  }

  /**
   * In the url form, expand `graphs.allOntologies` and `graphs.allShapes` in a read's `graphs`
   * from this store's registry cache (per dataset, updated by its own graph queries, dropped by a
   * pushed invalidation, re-read after 30 seconds), so the data server reads exactly the graphs
   * this process knows of. Other names (graph IRIs, `graphs.default`, `graphs.union`) go as they
   * are, for the data server's store to resolve. A name that expands to no graph is sent as is,
   * so the data server answers from its own registry; so is every name when the registry cannot
   * be read (the data server refused or failed the record selects), with one warning per store.
   * The no-url form sends `graphs` unchanged: the backend's store expands them.
   */
  private async withReadGraphs(json: unknown): Promise<unknown> {
    if (this.url === undefined || !json || typeof json !== 'object') return json;
    const names = (json as { graphs?: unknown }).graphs;
    if (!Array.isArray(names) || !names.some((name) => REGISTRY_EXPANDED.has(name))) return json;
    let registry: Awaited<ReturnType<typeof readGraphRegistry>>;
    try {
      registry = await readGraphRegistry(this.graphRegistryKey(), () => this.loadGraphRegistry());
    } catch (err) {
      if (!this.warnedRegistryRead) {
        this.warnedRegistryRead = true;
        console.warn(
          `RemoteDataset: could not read the graph registry at ${this.url}; reads send graph names unexpanded:`,
          err instanceof Error ? err.message : err,
        );
      }
      return json;
    }
    const out: string[] = [];
    const add = (iri: string) => {
      if (!out.includes(iri)) out.push(iri);
    };
    for (const name of names as string[]) {
      const recordClass = REGISTRY_EXPANDED.get(name);
      if (!recordClass) {
        add(name);
        continue;
      }
      const listed = [...registry].filter(([, classes]) => classes.has(recordClass)).map(([graph]) => graph);
      if (listed.length) listed.sort().forEach(add);
      else add(name);
    }
    return { ...(json as Record<string, unknown>), graphs: out };
  }

  private call<T>(method: Method, json: unknown): Promise<T> {
    if (this.url === undefined) return this.callBackend(method, json);
    return this.post(method, [json]) as Promise<T>;
  }

  /**
   * Opts in to `rejectOnError`, so a failed call (HTTP error status, or no
   * provider on the backend) rejects with a `ServerCallError` carrying the
   * status and the server's message instead of reading as an empty result.
   * Whatever a successful call returns, `undefined` included, resolves as is.
   */
  private callBackend<T>(method: string, json: unknown): Promise<T> {
    // The PACKAGE form, not the shape form. It posts to
    // `/call/<packageName>/<method>` with a body of `{args}` only — no `shapeURI`,
    // no `instanceNode` — and the backend answers from this package's generic
    // provider without resolving or instantiating any Shape.
    return Server.call(packageName, { method, rejectOnError: true }, json);
  }

  /**
   * The url form: one POST to `{url}/call/@_linked/server/<method>`. Resolves the parsed
   * body (`null` is a valid result: a method that returned `undefined`). Messages name the
   * url and the method, never the token.
   */
  private async post(method: Method, args: unknown[]): Promise<unknown> {
    const base = this.url ?? '';
    if (!base) {
      throw new RemoteDatasetUnreachableError(
        `RemoteDataset: no data server url is set (the configured url is empty); cannot ${method}`,
        '',
        0,
      );
    }
    const target = `${base}/call/${packageName}/${method}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.forwardEndUser) {
      const endUser = currentEndUserWebId();
      if (endUser) headers[END_USER_HEADER] = endUser;
    }

    let response: Response;
    try {
      response = await globalThis.fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify({ args }),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new RemoteDatasetUnreachableError(
        `RemoteDataset: cannot reach the data server at ${base} (${method}): ${cause}`,
        base,
        0,
      );
    }

    const text = await response.text();
    let body: unknown = undefined;
    let isJson = false;
    if (text) {
      try {
        body = JSON.parse(text);
        isJson = true;
      } catch {
        body = text;
      }
    }

    if (response.ok) {
      if (isJson) return body;
      if (method === 'ping') {
        throw new RemoteDatasetUnreachableError(
          `RemoteDataset: the data server at ${base} answered ping with a body that is not JSON`,
          base,
          response.status,
        );
      }
      if (!text) return undefined;
      throw new RemoteDatasetError(
        `RemoteDataset: the data server at ${base} answered ${method} with a body that is not JSON`,
        base,
        response.status,
      );
    }

    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
    const code = typeof record?.code === 'string' ? record.code : undefined;
    const detail =
      typeof record?.error === 'string'
        ? record.error
        : typeof body === 'string' && body
          ? body
          : response.statusText;
    const message = `RemoteDataset: the data server at ${base} answered ${method} with ${response.status}${
      code ? ` (${code})` : ''
    }${detail ? `: ${detail}` : ''}`;

    if (response.status === 401 || response.status === 403) {
      throw new RemoteDatasetUnauthorizedError(message, base, response.status, code);
    }
    if (method === 'ping' && (PING_UNREACHABLE_STATUSES.has(response.status) || !isJson)) {
      throw new RemoteDatasetUnreachableError(message, base, response.status, code);
    }
    throw new RemoteDatasetError(message, base, response.status, code);
  }
}
