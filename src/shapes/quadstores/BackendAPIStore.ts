import { packageName } from '../../package.js';
import { Server } from '@_linked/server-utils/utils/Server';
import type { IDataset } from '@_linked/core/interfaces/IDataset';
import type { SelectQuery } from '@_linked/core/queries/SelectQuery';
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
 * Constructor argument for `new BackendAPIStore(config)`. Per the
 * docs/backlog/016-ejection-export-flow.md spec — a single JSON object
 * passed verbatim from linked.{frontend,backend}.datasets.json's `config`.
 */
export interface BackendAPIStoreConfig {
  /** Stable name; becomes the suffix of the store URI: ${DATA_ROOT}/backend-api-store/<name>. */
  name?: string;
  /** Or pass a fully-qualified URI directly. */
  id?: string;
}

/**
 * Frontend-side store that routes all queries to the backend via `Server.call()`.
 * The backend's generic provider for this package executes them against the real store.
 *
 * A store is not a Shape. This class used to `extends Shape` and carry `@linkedShape`
 * with a `targetClass`, purely so that `Server.call(this, …)` could address it: the
 * transport derived the target from `shape instanceof Shape && shape.id` (the instance)
 * and `shapeClass.shape.id` (the class). Neither carried any meaning — the backend
 * provider never read the store it was handed, and query routing is decided by the
 * QUERY's shape, not the store's.
 *
 * It now uses `Server.call`'s package form instead, which addresses the backend by
 * package name and sends no shape fields at all. That removes the last reason for this
 * class to be a Shape, and with it the `new (providerShapeClass)({id})` the backend had
 * to perform to rebuild a store instance nobody used.
 */
export class BackendAPIStore implements IDataset {
  /**
   * Kept so the config form is still accepted and a store can be named, but it is no
   * longer an addressing mechanism — nothing transmits or resolves it. Retained because
   * `linked.{frontend,backend}.datasets.json` may still pass `name`/`id`.
   */
  readonly id?: string;

  constructor(config?: BackendAPIStoreConfig | string | { id?: string }) {
    if (!config) return;
    if (typeof config === 'string') {
      this.id = `${process.env.DATA_ROOT}/backend-api-store/${config}`;
      return;
    }
    if ((config as BackendAPIStoreConfig).id) {
      this.id = (config as BackendAPIStoreConfig).id!;
      return;
    }
    if ((config as BackendAPIStoreConfig).name) {
      const name = (config as BackendAPIStoreConfig).name!;
      this.id = `${process.env.DATA_ROOT}/backend-api-store/${name}`;
    }
  }

  async init(): Promise<void> {
    // No initialization needed — queries are routed to the backend
  }

  // Queries serialize to DSL-JSON for the wire (core 2.10.0 contract flip): the
  // live (closed) query can't cross Server.call as-is, so we ship `toJSON()` and
  // the BackendAPIStoreProvider rehydrates with `fromJSON()` on the backend.
  selectQuery(query: SelectQuery): Promise<SelectResult> {
    return this.callBackend('selectQuery', query.toJSON());
  }

  askQuery(query: AskQuery): Promise<boolean> {
    return this.callBackend('askQuery', query.toJSON());
  }

  updateQuery(query: UpdateQuery): Promise<UpdateResult> {
    return this.callBackend('updateQuery', query.toJSON());
  }

  createQuery(query: CreateQuery): Promise<CreateResult> {
    return this.callBackend('createQuery', query.toJSON());
  }

  deleteQuery(query: DeleteQuery): Promise<DeleteResponse> {
    return this.callBackend('deleteQuery', query.toJSON());
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
}
