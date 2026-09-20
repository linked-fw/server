import { lincdServer } from '../../ontologies/lincd-server.js';
import { linkedShape } from '../../package.js';
import { Shape } from '@_linked/core/shapes/Shape';
import { Server } from '@_linked/server-utils/utils/Server';
import type { IDataset } from '@_linked/core/interfaces/IDataset';
import type { SelectQuery } from '@_linked/core/queries/SelectQuery';
import type { AskQuery } from '@_linked/core/queries/AskQuery';
import type { CountQuery } from '@_linked/core/queries/CountQuery';
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
 * Frontend-side store that routes all queries to the backend via Server.call().
 * The backend's BackendAPIStoreProvider handles execution against the actual store.
 */
@linkedShape
export class BackendAPIStore extends Shape implements IDataset {
  static targetClass = lincdServer.BackendAPIStore;

  constructor(config?: BackendAPIStoreConfig | string | { id?: string }) {
    if (!config) {
      super();
      return;
    }
    if (typeof config === 'string') {
      // Legacy string-as-name form. Wrap into config shape.
      super({ id: `${process.env.DATA_ROOT}/backend-api-store/${config}` });
      return;
    }
    if ((config as BackendAPIStoreConfig).id) {
      super({ id: (config as BackendAPIStoreConfig).id! });
      return;
    }
    if ((config as BackendAPIStoreConfig).name) {
      const name = (config as BackendAPIStoreConfig).name!;
      super({ id: `${process.env.DATA_ROOT}/backend-api-store/${name}` });
      return;
    }
    super();
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

  /**
   * A count crosses the wire like every other query kind — `toJSON()` out,
   * `fromJSON()` on the backend. Its envelope carries `op: 'count'`, so an older
   * backend rejects it loudly rather than reinterpreting it as a select (which
   * would answer with rows where the caller expected a total).
   *
   * Nothing here rewrites a count as a select and counts the rows: `resolveCount`
   * requires a finite, non-negative integer, and `0` is a plausible count — a
   * wrong answer would read as an empty result set rather than as a failure. The
   * call therefore rejects (see `callBackend`) unless the backend really counted.
   */
  countQuery(query: CountQuery): Promise<number> {
    return this.callBackend('countQuery', query.toJSON());
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
    return Server.call(this, { method, rejectOnError: true }, json);
  }
}
