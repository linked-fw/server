import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { fromJSON } from '@_linked/core';
import { LocalFileStore } from './shapes/filestores/LocalFileStore.js';
import { getShapeIndex } from './utils/Shapes.js';
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

  selectQuery(json: any) {
    return LinkedStorage.selectQuery(fromJSON(json) as any);
  }

  askQuery(json: any) {
    return LinkedStorage.askQuery(fromJSON(json) as any);
  }

  updateQuery(json: any) {
    return LinkedStorage.updateQuery(fromJSON(json) as any);
  }

  createQuery(json: any) {
    return LinkedStorage.createQuery(fromJSON(json) as any);
  }

  deleteQuery(json: any) {
    return LinkedStorage.deleteQuery(fromJSON(json) as any);
  }
}
