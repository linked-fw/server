import { createNameSpace } from '@_linked/core/utils/NameSpace';

/**
 * Load the data of this ontology.
 * In @_linked/core, loadData returns the raw JSON import — no JSONLD.parse() needed.
 */
export var loadData = async () => {
  //@ts-ignore
  const data = await import('../data/server.json', {
    with: { type: 'json' },
  });
  return data.default || data;
};

/**
 * The namespace of this ontology.
 *
 * First-party ontologies live on linked.cm: `https://linked.cm/ont/{ontologySlug}/`, and a
 * package's own ontology takes the package's publicSlug (`@_linked/server` → `server`), the same
 * slug its shapes use under `https://linked.cm/shape/server/`.
 *
 * Its prefix label is the same slug, `server` (`server:LincdAPI`). It used to be `lincd-server`,
 * which is still registered as a deprecated alias so `lincd-server:` names keep expanding.
 *
 * Until an earlier release the namespace was `http://lincd.org/ont/lincd-server/`. No stored
 * data is typed with these terms; the only store triples that carried them were the synced shape descriptions of
 * `LinkedServer`, `LincdAPI` and `LincdWebApp` (`sh:targetClass`, `sh:path`), which boot sync
 * rewrites (delete, then recreate) the next time the server starts.
 */
export var ns = createNameSpace('https://linked.cm/ont/server/');

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

export const server = {
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

/** @deprecated use `server` — same object, kept under its old name. */
export const lincdServer = server;
