import { packageName } from '../../package.js';
import { brandLinkedError } from '@_linked/core/utils/linkedError';
import { Server } from '@_linked/server-utils/utils/Server';
import { getCallContext } from '@_linked/server-utils/utils/CallContext';
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
} from '@_linked/core/queries/IntermediateRepresentation';

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

/**
 * The WebID of the signed-in user behind the current call: the http context's
 * `request.linkedAuth.userAccount.accountOf.id`. Undefined in a system context
 * (`runAsSystem`), outside any call, and for a request without a session.
 */
export function currentEndUserWebId(): string | undefined {
  const ctx = getCallContext();
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
  | 'deleteQuery';

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
  selectQuery(query: SelectQuery | CountQuery): Promise<SelectResult | number> {
    return this.call('selectQuery', query.toJSON());
  }

  askQuery(query: AskQuery): Promise<boolean> {
    return this.call('askQuery', query.toJSON());
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
