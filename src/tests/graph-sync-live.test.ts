import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';

// [fuseki] The ontology phase of an app whose store is a `RemoteDataset` pointed at a linked
// server's generic plane, which runs graph queries on an inferring Fuseki (image `6.2.0-2`,
// which builds its hierarchy from the graph registry). The first run writes one graph per
// registered package, with its record; the second (a second boot) skips them all. Runs only when FUSEKI_BASE_URL names a store;
// it creates its own dataset there and deletes it afterwards.

const FUSEKI = process.env.FUSEKI_BASE_URL;
const describeLive = FUSEKI ? describe : describe.skip;
const ADMIN = `Basic ${Buffer.from(`admin:${process.env.FUSEKI_ADMIN_PASSWORD || 'admin'}`).toString('base64')}`;
const DATASET = `server-graph-sync-${process.pid}-${Date.now()}`;

process.env.SITE_ROOT ??= 'http://app.test:4000';
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
const { SparqlDataset } = await import('@_linked/core/sparql/SparqlDataset');
const { linkedPackage } = await import('@_linked/core/utils/Package');
const { createNameSpace } = await import('@_linked/core/utils/NameSpace');
const { OntologyGraph } = await import('@_linked/core/shapes/NamedGraph');
const { withAccess } = await import('@_linked/server-utils/utils/QueryAccess');
const { LinkedServer, registerCallRoutes } = await import('../shapes/LinkedServer.js');
const { default: LincdServerBackendProvider } = await import('../backend.js');
const { createJsonBodyParser } = await import('../utils/jsonBodyParser.js');
const { RemoteDataset } = await import('../shapes/quadstores/RemoteDataset.js');
const { loadOntologyCore, runOntologyPhase } = await import('../utils/ontologySync.js');

/** A Fuseki dataset over plain HTTP. */
class LiveFuseki extends (SparqlDataset as any) {
  constructor(private readonly endpoint: string) {
    super({});
  }
  async executeSparqlSelect(query: string) {
    const res = await fetch(`${this.endpoint}/sparql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-query', Accept: 'application/sparql-results+json' },
      body: query,
    });
    if (!res.ok) throw new Error(`select ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async executeSparqlUpdate(update: string) {
    const res = await fetch(`${this.endpoint}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: update,
    });
    if (!res.ok) throw new Error(`update ${res.status}: ${await res.text()}`);
  }
  async init() {}
}

const EX = 'http://example.org/server-graph-sync/';
const PACKAGES = ['server-graph-sync-a', 'server-graph-sync-b'];
linkedPackage(PACKAGES[0]).linkedOntology({}, createNameSpace(`${EX}a/`), 'gsa', async () => [
  `<${EX}a/Dog> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${EX}a/Animal> .\n` +
    `<${EX}a/Dog> <http://www.w3.org/2000/01/rdf-schema#label> "Dog" .`,
], '../data/a.ttl');
linkedPackage(PACKAGES[1]).linkedOntology({}, createNameSpace(`${EX}b/`), 'gsb', async () => [
  `<${EX}b/Cat> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${EX}a/Animal> .`,
], '../data/b.ttl');

const servers: any[] = [];
let base = '';
let store: any;

async function admin(path: string, init: RequestInit) {
  return fetch(`${FUSEKI}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: ADMIN } });
}

async function ask(query: string): Promise<boolean> {
  return (await store.executeSparqlSelect(query)).boolean;
}

describeLive('[fuseki] the ontology phase through RemoteDataset and the generic plane', () => {
  beforeAll(async () => {
    const created = await admin('/$/datasets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `dbName=${DATASET}&dbType=tdb2`,
    });
    expect(created.status).toBe(200);
    store = new LiveFuseki(`${FUSEKI}/${DATASET}`);
    LinkedStorage.setDefaultDataset(withAccess(store, { read: () => true, write: 'none', graph: () => true }) as any);
    const server: any = Object.create(LinkedServer.prototype);
    server.genericProviders = new Map([['@_linked/server', new LincdServerBackendProvider({}, server)]]);
    server.shapeProviders = new Map();
    server.providerIndexing = new Map();
    server.initRequest = async () => {};
    const app = express();
    app.use(createJsonBodyParser());
    registerCallRoutes(app, server);
    const s = await new Promise<any>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    servers.push(s);
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    if (FUSEKI) await admin(`/$/datasets/${DATASET}`, { method: 'DELETE' });
  });

  it('writes one graph per package with its record, then the route’s second run skips all', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const remote = new RemoteDataset({ url: base });
    await remote.init();
    const core = await loadOntologyCore();
    const lines: string[] = [];
    const log = (m: string) => {
      lines.push(m);
      process.stdout.write(`${m}\n`);
    };

    const first = await runOntologyPhase(remote, { core, sync: true, orphanScope: 'none', log, warn: () => {} });
    expect(first.failure).toBeUndefined();
    const graphsOf = (names: string[]) => names.map((p) => OntologyGraph.iriFor(p)).sort();
    expect(first.ontologies.written).toEqual(expect.arrayContaining(PACKAGES));
    expect(first.ontologies.graphs).toEqual(graphsOf(first.ontologies.written));
    for (const pkg of PACKAGES) {
      const g = OntologyGraph.iriFor(pkg);
      expect(
        await ask(
          `ASK { GRAPH <https://linked.cm/pkg/core/graph/registry> { <${g}> a <https://linked.cm/ont/core/OntologyGraph> ; <https://linked.cm/ont/core/feedsHierarchy> true ; <https://linked.cm/ont/core/package> "${pkg}" } }`,
        ),
      ).toBe(true);
    }
    // Nothing in the default graph; the store infers the hierarchy from the package graphs.
    expect(await ask(`ASK { <${EX}a/Dog> ?p ?o }`)).toBe(false);
    await store.executeSparqlUpdate(`INSERT DATA { <${EX}rex> a <${EX}a/Dog> }`);
    expect(await ask(`ASK { <${EX}rex> a <${EX}a/Animal> }`)).toBe(true);

    // A second boot: every package's graph is unchanged, so nothing is written.
    const second = await runOntologyPhase(remote, { core, sync: true, orphanScope: 'none', log, warn: () => {} });
    expect(second.failure).toBeUndefined();
    expect(second.ontologies.written).toEqual([]);
    expect(second.ontologies.graphs).toEqual([]);
    expect(second.ontologies.skipped).toEqual(expect.arrayContaining(PACKAGES));
    expect(lines.filter((l) => l.includes('ontology sync'))).toHaveLength(2);
  });
});
