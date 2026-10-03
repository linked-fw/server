import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { callable } from '@_linked/server-utils/utils/callable';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { LocalFileStore } from './shapes/filestores/LocalFileStore.js';
import { getShapeIndex } from './utils/Shapes.js';
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

  // Not callable over RPC: no client calls it. Clients read the same index
  // through LincdAPI's `/api/all-shapes` and `/api/shape-details`; backend code
  // can still reach it with a local `Server.call`.
  getShapes() {
    return getShapeIndex();
  }

  // ── BackendAPIStore query execution ──────────────────────────────────────
  //
  // These answer the frontend `BackendAPIStore`, which calls
  // `Server.call(packageName, {method}, json)` — the PACKAGE form, so the request
  // arrives here on the generic provider rather than through Shape resolution.
  //
  // They used to live on `BackendAPIStoreProvider`, a `ShapeProvider`, whose methods
  // took the store as a first argument and never read it. Reaching that provider meant
  // the transport had to carry a `shapeURI` and an `instanceNode`, and the server had to
  // rebuild the store with `new (providerShapeClass)({id})` — instantiating a Shape only
  // to discard it. Addressing by package removes all of that.
  //
  // A query cannot cross the wire live (core 2.10.0 contract flip), so the client ships
  // `toJSON()` and `fromJSON()` rehydrates it here into a live, closed query.
  // `LinkedStorage` then routes it by the QUERY's shape — which is, and always was, what
  // decides the target dataset. The store instance never participated.

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
