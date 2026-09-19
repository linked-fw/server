import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { LocalFileStore } from './shapes/filestores/LocalFileStore.js';
import { getShapeIndex } from './utils/Shapes.js';
import path from 'path';
import fs from 'fs/promises';

export * from './shapes/quadstores/BackendAPIStoreProvider.js';

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
}
