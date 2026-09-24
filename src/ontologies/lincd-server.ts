import { createNameSpace } from '@_linked/core/utils/NameSpace';

/**
 * Load the data of this ontology.
 * In @_linked/core, loadData returns the raw JSON import — no JSONLD.parse() needed.
 */
export var loadData = async () => {
  //@ts-ignore
  const data = await import('../data/lincd-server.json', {
    with: { type: 'json' },
  });
  return data.default || data;
};

export var ns = createNameSpace('http://lincd.org/ont/lincd-server/');

export var _self = ns('');

// Terms are properties of the namespace object below, not module-scope
// exports. Most of these names are also SHAPE CLASS names in this package
// (BackendAPIStore, LincdWebApp, LincdAPI, ...). Two bindings of the same name
// in one bundle scope make the bundler rename one of them, and when the loser
// is the class, `constructor.name` becomes `BackendAPIStore2` -- which is the
// shape's IRI and the name `Server.call` routes on. The client then asks a
// backend that has no such shape, and every store round-trip answers 501.
const LincdServer = ns('LincdServer');
const BackendFileStore = ns('BackendFileStore');
const NodeFileStore = ns('NodeFileStore');
const BackendStore = ns('BackendStore');
const BackendAPIStore = ns('BackendAPIStore');
const LincdWebApp = ns('LincdWebApp');
const ownPackage = ns('ownPackage');
const maintainsPackage = ns('maintainsPackage');
const N3FileStore = ns('N3FileStore');
const LincdAPI = ns('LincdAPI');
const hasAPI = ns('hasAPI');

export const lincdServer = {
  LincdServer,
  BackendFileStore,
  NodeFileStore,
  BackendStore,
  N3FileStore,
  BackendAPIStore,
  LincdWebApp,
  ownPackage,
  maintainsPackage,
  LincdAPI,
  hasAPI,
};

