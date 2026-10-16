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
 * Constructor argument for `new GatewayStore(config)` — the `config` object of a
 * `linked.backend.datasets.json` entry, passed verbatim by `loadStores`.
 */
export interface GatewayStoreConfig {
  /** Base URL of the gateway, e.g. `http://localhost:4040/gateway`. Routes are appended to it. */
  endpoint: string;
  /** The bearer credential the gateway issued to this process. */
  credential: string;
  /** Transport override; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/** The op names on the wire; each is the `IDataset` method the store was called on. */
export type GatewayOp = 'select' | 'ask' | 'update' | 'create' | 'delete';

/** The wire version this store speaks. The gateway refuses any other with `code: "wire-version"`. */
export const GATEWAY_WIRE_VERSION = 1;

/**
 * A non-2xx answer from the gateway. `code` is the body's `code` when the gateway sent one
 * (`bad-request`, `wire-version`, `unknown-shape`, `refused`, `fork-failed`, `query-failed`),
 * else a generic one; `body` is the parsed response when it was JSON.
 */
export class GatewayStoreError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body?: unknown;

  constructor(message: string, status: number, code: string, body?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * The gateway could not be used at all: the request never got an HTTP answer (network error,
 * `status` 0), or the gateway refused the credential (401). Thrown by `init()` and by every
 * query method; a process that gets this at boot should stop rather than carry on without data.
 */
export class GatewayUnreachableError extends GatewayStoreError {}

/** What `GET {endpoint}/health` answers with a valid credential. */
export interface GatewayHealth {
  projectId: string;
  branchName: string;
  dataset: string;
}

/**
 * An {@link IDataset} that forwards every Linked Query to a gateway over HTTP and returns
 * the gateway's result as is.
 *
 * Each query method posts `{v, op, query: query.toJSON()}` to `POST {endpoint}/query` with
 * `Authorization: Bearer <credential>` and resolves with the body's `result` — the same plain
 * JSON rows `BackendAPIStore` returns. The gateway decides which dataset the query runs on
 * from the credential; the store carries no project, branch or actor.
 *
 * Unlike `BackendAPIStore` it does not go through `Server.call` and has no dependency on
 * the process's own HTTP server: it is meant for a backend whose data lives behind another
 * service, selected from `linked.backend.datasets.json` by the host that started it.
 *
 * The store offers no raw SPARQL (`rawQuery`), no dataset administration and no change feed.
 */
export class GatewayStore implements IDataset {
  readonly endpoint: string;
  private readonly credential: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GatewayStoreConfig) {
    const endpoint = typeof config?.endpoint === 'string' ? config.endpoint.trim() : '';
    const credential = typeof config?.credential === 'string' ? config.credential.trim() : '';
    if (!endpoint) {
      throw new Error(
        'GatewayStore: `endpoint` is empty. A gateway store needs the URL of the gateway ' +
          '(the host that started this process sets it, e.g. through CN_EG_GATEWAY).',
      );
    }
    if (!credential) {
      throw new Error(
        'GatewayStore: `credential` is empty. A gateway store needs the bearer credential ' +
          'the gateway issued to this process (e.g. CN_APP_SERVICE_SECRET).',
      );
    }
    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('GatewayStore: no `fetch` available; pass one in the config.');
    }
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.credential = credential;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Checks the gateway answers for this credential: `GET {endpoint}/health`. Resolves with the
   * gateway's answer; throws {@link GatewayUnreachableError} when the gateway cannot be reached
   * or refuses the credential. Safe to call more than once; it changes nothing on either side.
   *
   * `LinkedStorage.setDefaultDataset` calls `init()` without awaiting it, so a boot that must
   * fail loudly awaits `init()` itself before registering the store.
   */
  async init(): Promise<GatewayHealth> {
    return (await this.request('GET', '/health')) as GatewayHealth;
  }

  selectQuery(query: SelectQuery | CountQuery): Promise<SelectResult | number> {
    return this.send('select', query.toJSON());
  }

  askQuery(query: AskQuery): Promise<boolean> {
    return this.send('ask', query.toJSON());
  }

  updateQuery(query: UpdateQuery): Promise<UpdateResult> {
    return this.send('update', query.toJSON());
  }

  createQuery(query: CreateQuery): Promise<CreateResult> {
    return this.send('create', query.toJSON());
  }

  deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    return this.send('delete', query.toJSON());
  }

  private async send<T>(op: GatewayOp, query: unknown): Promise<T> {
    const body = (await this.request('POST', '/query', {
      v: GATEWAY_WIRE_VERSION,
      op,
      query,
    })) as { result?: T } | null;
    if (!body || typeof body !== 'object' || !('result' in body)) {
      throw new GatewayStoreError(
        `GatewayStore: the gateway answered ${op} without a result`,
        200,
        'bad-response',
        body,
      );
    }
    return body.result as T;
  }

  private async request(method: 'GET' | 'POST', route: string, json?: unknown): Promise<unknown> {
    const url = this.endpoint + route;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credential}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new GatewayUnreachableError(
        `GatewayStore: cannot reach the gateway at ${url}: ${cause}`,
        0,
        'unreachable',
      );
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (response.ok) return body;

    const code =
      body && typeof body === 'object' && typeof (body as any).code === 'string'
        ? ((body as any).code as string)
        : `http-${response.status}`;
    const detail =
      body && typeof body === 'object' && typeof (body as any).error === 'string'
        ? (body as any).error
        : typeof body === 'string' && body
          ? body
          : response.statusText;
    const message = `GatewayStore: ${method} ${url} answered ${response.status} (${code})${
      detail ? `: ${detail}` : ''
    }`;

    if (response.status === 401) {
      throw new GatewayUnreachableError(message, 401, code, body);
    }
    throw new GatewayStoreError(message, response.status, code, body);
  }
}
