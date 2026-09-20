import { BackendAPIStore } from './BackendAPIStore.js';
import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { fromJSON } from '@_linked/core';

/**
 * Server-side provider that handles BackendAPIStore query requests.
 *
 * The client (BackendAPIStore) ships each query as DSL-JSON over Server.call
 * (core 2.10.0 contract flip — the live query can't cross the wire). Here we
 * rehydrate it with `fromJSON()` back into a live (closed) query, then route it
 * through LinkedStorage, which delegates to the actual backend store (e.g.
 * FusekiStore) — the store lowers the live query to IR/SPARQL itself.
 */
export class BackendAPIStoreProvider extends ShapeProvider {
  public shape = BackendAPIStore;

  selectQuery(store: BackendAPIStore, json: any) {
    return LinkedStorage.selectQuery(fromJSON(json) as any);
  }

  askQuery(store: BackendAPIStore, json: any) {
    return LinkedStorage.askQuery(fromJSON(json) as any);
  }

  // There is deliberately no `countQuery` handler yet. The client store implements
  // `IDataset.countQuery` (core is making it required), but the backend half has
  // nothing to route to: `LinkedStorage` exposes no `countQuery`, `setQueryDispatch`
  // does not register one, and no concrete store (FusekiStore, rdf-mem-store)
  // implements it. A handler here could only answer by rewriting the count as a
  // select and counting rows — which `resolveCount` exists to forbid, since a wrong
  // count is a plausible number rather than a visible failure. Until core lands the
  // storage-side count, a `countQuery` call rejects with a ServerCallError naming
  // the missing provider method, which is the honest answer.

  updateQuery(store: BackendAPIStore, json: any) {
    return LinkedStorage.updateQuery(fromJSON(json) as any);
  }

  createQuery(store: BackendAPIStore, json: any) {
    return LinkedStorage.createQuery(fromJSON(json) as any);
  }

  deleteQuery(store: BackendAPIStore, json: any) {
    return LinkedStorage.deleteQuery(fromJSON(json) as any);
  }
}
