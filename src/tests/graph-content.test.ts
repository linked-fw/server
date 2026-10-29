import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';

// POST /admin/graph-content: behind the admin secret; 400 for a bad name or a package it may not
// reload; 409 when a graph target is not 'package'; the body equals what the app writer stores
// (text and hash, per package and for the app graph); appGraph null without single-owner shapes
// and absent without DATA_ROOT; an installed package without shapes.ttl has no shape graph.

process.env.SITE_ROOT ??= 'http://app.test:4000';
const { registerAdminRoutes, parseGraphContentBody } = await import('../utils/adminChannel.js');
const { SparqlDataset } = await import('@_linked/core/sparql/SparqlDataset');
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
const { setGraphTargets } = await import('@_linked/core/utils/graphTargets');
const { linkedPackage } = await import('@_linked/core/utils/Package');
const { createNameSpace } = await import('@_linked/core/utils/NameSpace');
const { Shape } = await import('@_linked/core/shapes/Shape');
const { objectProperty } = await import('@_linked/core/shapes/SHACL');
const { ShapesGraph, OntologyGraph } = await import('@_linked/core/shapes/NamedGraph');
const { LinkedServer } = await import('../shapes/LinkedServer.js');
const { graphContentOf } = await import('../utils/syncShapes.js');

const SECRET = 'graph-content-secret';
const APP_GRAPH = 'https://gc.example/data/graph/shapes';
const NS = 'https://example.org/gcs-onto/';

/** Keeps what each graph query wrote (body and hash); reads nothing back. */
class Recording extends (SparqlDataset as any) {
  written = new Map<string, { text?: string; hash?: string; mediaType?: string }>();
  async selectQuery() {
    return [];
  }
  async askQuery() {
    return false;
  }
  async graphQuery(query: { kind: string; graph: string; content?: { text: string; mediaType: string }; contentHash?: string }) {
    if (query.kind === 'graph_create' || query.kind === 'graph_replace') {
      this.written.set(query.graph, { text: query.content?.text, hash: query.contentHash, mediaType: query.content?.mediaType });
    }
    return { graph: query.graph, contentHash: query.contentHash, changed: true };
  }
  async executeSparqlSelect() {
    return { head: { vars: [] }, results: { bindings: [] } };
  }
  async executeSparqlUpdate() {}
}

// The app's own package: one shape now, a contains shape later; an ontology package with data.
const app = linkedPackage('gcs-app');
class GcsPart extends (Shape as any) {
  static targetClass = { id: 'https://example.org/gcs#Part' };
}
(app.linkedShape as any)(GcsPart);
linkedPackage('gcs-onto').linkedOntology(
  {},
  createNameSpace(NS),
  'gcs-onto',
  async () => [`<${NS}Wheel> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${NS}Part> .`],
  '../data/gcs-onto.ttl',
);

function server(): any {
  const s: any = Object.create(LinkedServer.prototype);
  Object.assign(s, {
    config: { server: {} },
    package: { name: 'gcs-app' },
    linkedPackageDirs: new Map(),
    workspacePackageDirs: [],
    workspacePackageNames: new Set<string>(),
    shapeSyncQueue: Promise.resolve(),
  });
  return s;
}

const servers: any[] = [];
let base: string;
let store: any;
let before: unknown;
const savedRoot = process.env.DATA_ROOT;

beforeAll(async () => {
  store = new (Recording as any)();
  before = LinkedStorage.getDefaultDataset();
  LinkedStorage.setDefaultDataset(store);
  const s = server();
  const appExpress = express();
  appExpress.use(express.json());
  registerAdminRoutes(appExpress, SECRET, {
    exit: () => {},
    syncShapes: (r) => s.resyncShapes(r),
    graphContent: (r) => s.graphContent(r),
  });
  const srv = await new Promise<any>((resolve) => {
    const x = appExpress.listen(0, () => resolve(x));
  });
  servers.push(srv);
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  if (before) LinkedStorage.setDefaultDataset(before as any);
});

afterEach(() => {
  setGraphTargets({});
  if (savedRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = savedRoot;
  jest.restoreAllMocks();
});

const post = (body: unknown, secret: string | null = SECRET) =>
  fetch(`${base}/admin/graph-content`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-app-admin-secret': secret } : {}) },
    body: JSON.stringify(body),
  });

const quiet = () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
};

describe('POST /admin/graph-content', () => {
  it('needs the admin secret', async () => {
    expect((await post({}, null)).status).toBe(401);
    expect((await post({}, 'wrong')).status).toBe(401);
  });

  it('400 for a bad body, a bad name, or a package it may not reload', async () => {
    expect(() => parseGraphContentBody([])).toThrow('the body must be a JSON object');
    expect(parseGraphContentBody(undefined)).toEqual({ reload: [] });
    expect(parseGraphContentBody({ packages: ['a', 'a'], reload: ['gcs-app'] })).toEqual({ packages: ['a'], reload: ['gcs-app'] });
    const bad = await post({ packages: ['../etc'] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('not a package name: "../etc"');
    expect((await post({ packages: 'gcs-app' })).status).toBe(400);
    const framework = await post({ reload: ['@_linked/core'] });
    expect(framework.status).toBe(400);
    expect((await framework.json()).error).toBe('framework packages are not reloaded: @_linked/core');
    expect((await post({ reload: ['left-pad-unknown'] })).status).toBe(400);
  });

  it("409 when a graph target is not 'package', naming it", async () => {
    setGraphTargets({ shapeGraph: 'default' });
    const res = await post({});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(`shapeGraph is "default" (LINKED_SHAPE_GRAPH)`);
    setGraphTargets({ ontologyGraph: 'https://gc.example/graph/ontology' });
    expect((await (await post({})).json()).error).toContain('ontologyGraph is "https://gc.example/graph/ontology" (LINKED_ONTOLOGY_GRAPH)');
  });

  it('without DATA_ROOT no appGraph', async () => {
    quiet();
    delete process.env.DATA_ROOT;
    const without = await (await post({ packages: ['gcs-app'] })).json();
    expect('appGraph' in without).toBe(false);
    expect(without.graphTargets).toEqual({ ontologyGraph: 'package', shapeGraph: 'package' });
    expect(without.reloaded).toEqual([]);
  });

  it("appGraph null when core finds no single-owner shapes (core's own built-ins declare some, so only a stand-in shows it); an installed package without shapes.ttl has no shape graph", async () => {
    const asked: any[] = [];
    const content = await graphContentOf({
      core: {
        packagesWithShapes: () => ['dep', 'bare'],
        shapesGraphFor: (name) => `https://linked.cm/pkg/${name}/graph/shapes`,
        syncShapeGraphs: async () => ({ written: [], skipped: [], pruned: [], cleaned: 0 }),
        graphContent: async (options) => {
          asked.push(options);
          const part = (name: string) => ({ graph: `g/${name}`, mediaType: 'text/turtle' as const, text: `T ${name}`, hash: 'h', sources: ['data/shapes.ttl'] });
          return { packages: [{ name: 'bare', shapes: part('bare') }, { name: 'dep', shapes: part('dep') }], appGraph: null, withoutTurtle: [], unreadable: [] };
        },
      },
      isOwn: () => false,
      dev: false,
      packageDirOf: (name) => `/n/${name}`,
      read: (dir) => (dir === '/n/dep' ? 'DEP TTL' : undefined),
      appGraph: APP_GRAPH,
    });
    expect(asked[0].appShapes).toEqual({ graph: APP_GRAPH });
    expect(await asked[0].turtleFor('dep')).toBe('DEP TTL');
    expect(content.appGraph).toBeNull();
    expect(content.packages).toEqual([{ name: 'bare' }, { name: 'dep', shapes: expect.objectContaining({ text: 'T dep' }) }]);
    expect(content.withoutTurtle).toEqual(['bare']);
  });

  it('answers exactly what the app writer stores, and writes nothing itself', async () => {
    quiet();
    process.env.DATA_ROOT = 'https://gc.example/data';
    const linkedShape = app.linkedShape as any;
    @linkedShape
    class GcsWhole extends (Shape as any) {
      static targetClass = { id: 'https://example.org/gcs#Whole' };
      @objectProperty({ path: { id: 'https://example.org/gcs#part' }, shape: GcsPart as any, maxCount: 1, contains: true })
      get part(): unknown {
        return null;
      }
    }
    expect(GcsWhole).toBeDefined();

    store.written.clear();
    const res = await post({ packages: ['gcs-app', 'gcs-onto'] });
    expect(res.status).toBe(200);
    const content = await res.json();
    expect(store.written.size).toBe(0);

    const s = server();
    await s.syncOntologiesOnBoot();
    await s.materializeShapesIntoStore();

    const shapes = content.packages.find((p: any) => p.name === 'gcs-app').shapes;
    const shapesStored = store.written.get(ShapesGraph.iriFor('gcs-app'));
    expect(shapes).toEqual({
      graph: ShapesGraph.iriFor('gcs-app'),
      mediaType: 'text/turtle',
      text: shapesStored.text,
      hash: shapesStored.hash,
      sources: ['data/shapes.ttl'],
    });
    const ontology = content.packages.find((p: any) => p.name === 'gcs-onto').ontology;
    const ontologyStored = store.written.get(OntologyGraph.iriFor('gcs-onto'));
    expect(ontology).toEqual({
      graph: OntologyGraph.iriFor('gcs-onto'),
      mediaType: 'application/n-triples',
      text: ontologyStored.text,
      hash: ontologyStored.hash,
      sources: ['data/gcs-onto.ttl'],
    });
    const appStored = store.written.get(APP_GRAPH);
    expect(content.appGraph).toEqual({ graph: APP_GRAPH, mediaType: 'text/turtle', text: appStored.text, hash: appStored.hash, sources: [] });
  });
});
