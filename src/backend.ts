import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { callable } from '@_linked/server-utils/utils/callable';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { LocalFileStore } from './shapes/filestores/LocalFileStore.js';
import { authorizeGenericQuery, toQueryBuilder } from './utils/queryPlane.js';
import path from 'path';
import fs from 'fs/promises';

export default class LincdServerBackendProvider extends BackendProvider {
  async setupBeforeControllers() {
    if (!LinkedFileStorage.getDefaultStore()) {
      LinkedFileStorage.setDefaultStore(
        new LocalFileStore(process.env.NODE_ENV + '-filestore')
      );
    }
    let fileSystemUploadPath = path.join('data', 'filestores');
    try {
      await fs.access(fileSystemUploadPath);
    } catch (err) {
      await fs.mkdir(path.join(fileSystemUploadPath, 'filestores'), {
        recursive: true,
      });
    }
  }

  /**
   * Reachability check for a `RemoteDataset` pointed at this server: reads nothing, changes
   * nothing. A plain linked server has no token concept, so it always answers `{ok: true}`;
   * a host that serves the wire with tokens answers 401 for a refused one.
   */
  @callable('public')
  async ping(): Promise<{ ok: true }> {
    return { ok: true };
  }

  // ── Generic query execution ──────────────────────────────────────────────
  //
  // These answer `RemoteDataset`: a browser's store calls
  // `Server.call(packageName, {method}, json)` (the PACKAGE form), and a remote app's store
  // posts the same `{args}` body to `{url}/call/@_linked/server/<method>`. Either way the
  // request arrives here on the generic provider rather than through Shape resolution.
  //
  // A query cannot cross the wire live, so the client ships `toJSON()` and `fromJSON()`
  // rehydrates it here into a live, closed query. `LinkedStorage` then routes it by the
  // QUERY's shape, which is what decides the target dataset; the store instance never
  // participates.
  //
  // Every query is checked first against the access rules of the stores it
  // maps to, declared in the app's storage config (`withAccess`; a store with
  // no rule requires a session): see utils/queryPlane. INTERIM model, to be
  // rethought. The store runs the builder that was checked. They are declared
  // 'public' because that check, not the RPC layer, decides whether a session
  // is required.

  @callable('public')
  async selectQuery(json: any) {
    const query = toQueryBuilder(json);
    await authorizeGenericQuery('select', json, query, 'selectQuery');
    return LinkedStorage.selectQuery(query);
  }

  @callable('public')
  async askQuery(json: any) {
    const query = toQueryBuilder(json);
    await authorizeGenericQuery('ask', json, query, 'askQuery');
    return LinkedStorage.askQuery(query);
  }

  @callable('public')
  async updateQuery(json: any) {
    const query = toQueryBuilder(json);
    await authorizeGenericQuery('update', json, query, 'updateQuery');
    return LinkedStorage.updateQuery(query);
  }

  @callable('public')
  async createQuery(json: any) {
    const query = toQueryBuilder(json);
    await authorizeGenericQuery('create', json, query, 'createQuery');
    return LinkedStorage.createQuery(query);
  }

  @callable('public')
  async deleteQuery(json: any) {
    const query = toQueryBuilder(json);
    await authorizeGenericQuery('delete', json, query, 'deleteQuery');
    return LinkedStorage.deleteQuery(query);
  }
}
