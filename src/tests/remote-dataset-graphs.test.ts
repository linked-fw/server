import { afterEach, describe, expect, it } from '@jest/globals';

// Graph queries through `RemoteDataset`: `graphQuery` goes out on the same wire as every other
// query, refusals come back as `GraphQueryError`s, and in the url form the store expands
// `graphs.allOntologies` from its own registry cache, which its graph queries update and a pushed
// invalidation drops. The data server is a stubbed `globalThis.fetch`.

process.env.SITE_ROOT ??= 'http://app.test:4000';
const { Server } = await import('@_linked/server-utils/utils/Server');
const { RemoteDataset, RemoteDatasetUnauthorizedError, END_USER_HEADER } = await import(
  '../shapes/quadstores/RemoteDataset.js'
);
const { runWithCallContext } = await import('@_linked/server-utils/utils/CallContext');
const { packageName } = await import('../package.js');
const { graphs } = await import('@_linked/core/ontologies/graphs');
const { isGraphQueryError } = await import('@_linked/core/queries/graphQuery');
const { invalidateGraphRegistry, GRAPH_REGISTRY_MAX_AGE_MS } = await import(
  '@_linked/core/utils/graphRegistryCache'
);
const { OntologyGraph, ShapesGraph } = await import('@_linked/core/shapes/NamedGraph');
const { syncOntologies } = await import('@_linked/core/ontology/syncOntologies');

const URL_BASE = 'http://cn.test:4040/gateway';
const TOKEN = 'c'.repeat(64);
const G_A = 'https://linked.cm/pkg/a/graph/ontology';
const G_B = 'https://linked.cm/pkg/b/graph/ontology';
const G_S = 'https://linked.cm/pkg/a/graph/shapes';
const ONTOLOGY_SHAPE = OntologyGraph.shape.id;
const SHAPES_SHAPE = ShapesGraph.shape.id;

type Call = { url: string; init: RequestInit };

const originalFetch = globalThis.fetch;
const originalCall = Server.call;

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  (Server as any).call = originalCall;
  invalidateGraphRegistry();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sent = (call: Call): any => JSON.parse(String(call.init.body));
const methodOf = (call: Call) => call.url.slice(call.url.lastIndexOf('/') + 1);

function queryJson(json: Record<string, unknown>) {
  return { toJSON: () => json } as any;
}

/**
 * A data server with a registry: `selectQuery` of a registry record shape answers its records
 * (and is counted), any other select answers `[]` and records the `graphs` it was sent.
 */
function stubPlane(registry: { ontology: string[]; shapes: string[] }, dataset = 'app-data-main') {
  const calls: Call[] = [];
  const registryReads: string[] = [];
  const readGraphs: unknown[] = [];
  (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const method = methodOf(call);
    if (method === 'ping') return jsonResponse(200, { ok: true, dataset });
    const query = sent(call).args?.[0];
    if (method === 'selectQuery' && query?.shape === ONTOLOGY_SHAPE) {
      registryReads.push('ontology');
      return jsonResponse(200, registry.ontology.map((id) => ({ id })));
    }
    if (method === 'selectQuery' && query?.shape === SHAPES_SHAPE) {
      registryReads.push('shapes');
      return jsonResponse(200, registry.shapes.map((id) => ({ id })));
    }
    if (method === 'graphQuery') {
      return jsonResponse(200, { graph: query.graph, changed: true, contentHash: 'h' });
    }
    readGraphs.push(query?.graphs);
    return jsonResponse(200, method === 'askQuery' ? false : []);
  };
  return { calls, registryReads, readGraphs };
}

const replace = {
  kind: 'graph_replace' as const,
  graph: G_A,
  recordClass: OntologyGraph.targetClass.id,
  content: { mediaType: 'application/n-triples' as const, text: '<http://e/s> <http://e/p> <http://e/o> .\n' },
};

describe('RemoteDataset.graphQuery', () => {
  it('posts the graph query as is, with the token and the end user, and resolves the result', async () => {
    const plane = stubPlane({ ontology: [], shapes: [] });
    const ds = new RemoteDataset({ url: URL_BASE, token: TOKEN });
    const result = await runWithCallContext(
      { kind: 'http', request: { linkedAuth: { userAccount: { accountOf: { id: 'https://u.test/me' } } } } } as any,
      () => ds.graphQuery(replace),
    );
    expect(result).toEqual({ graph: G_A, changed: true, contentHash: 'h' });
    const [call] = plane.calls;
    expect(call.url).toBe(`${URL_BASE}/call/${packageName}/graphQuery`);
    expect(sent(call)).toEqual({ args: [replace] });
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers[END_USER_HEADER]).toBe('https://u.test/me');
  });

  it('turns a refusal with a graph code into a GraphQueryError with that code', async () => {
    for (const code of ['graph-exists', 'graph-not-registered', 'graph-name-read-only', 'unsupported-query-kind']) {
      (globalThis as any).fetch = async () => jsonResponse(409, { error: `refused: ${code}`, code });
      const err = await new RemoteDataset({ url: URL_BASE }).graphQuery(replace).catch((e) => e);
      expect(isGraphQueryError(err, code as any)).toBe(true);
      expect(err.graph).toBe(G_A);
      expect(err.message).toContain(`refused: ${code}`);
    }
  });

  it('reads a server or gateway without the method (404, 501) as unsupported-query-kind', async () => {
    for (const status of [404, 501]) {
      (globalThis as any).fetch = async () => jsonResponse(status, { error: 'not found' });
      const err = await new RemoteDataset({ url: URL_BASE }).graphQuery(replace).catch((e) => e);
      expect(isGraphQueryError(err, 'unsupported-query-kind')).toBe(true);
    }
  });

  it('keeps a refused token (403) and a failure (500) as they are', async () => {
    (globalThis as any).fetch = async () => jsonResponse(403, { error: 'Forbidden' });
    const refused = await new RemoteDataset({ url: URL_BASE }).graphQuery(replace).catch((e) => e);
    expect(refused).toBeInstanceOf(RemoteDatasetUnauthorizedError);
    expect(isGraphQueryError(refused)).toBe(false);
    (globalThis as any).fetch = async () => jsonResponse(500, { error: 'boom' });
    const failed = await new RemoteDataset({ url: URL_BASE }).graphQuery(replace).catch((e) => e);
    expect(isGraphQueryError(failed)).toBe(false);
    expect(failed.status).toBe(500);
  });

  it('the no-url form calls the backend’s graphQuery and maps its refusal', async () => {
    const seen: unknown[] = [];
    (Server as any).call = async (pkg: string, config: any, json: unknown) => {
      seen.push([pkg, config.method, config.rejectOnError, json]);
      throw Object.assign(new Error('exists'), { status: 409, code: 'graph-exists' });
    };
    const err = await new RemoteDataset().graphQuery(replace).catch((e) => e);
    expect(seen).toEqual([[packageName, 'graphQuery', true, replace]]);
    expect(isGraphQueryError(err, 'graph-exists')).toBe(true);
  });

  it('lets the ontology sync fall back to the default graph behind a gateway without graph queries', async () => {
    const methods: string[] = [];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      methods.push(methodOf(call));
      if (methodOf(call) === 'graphQuery') return jsonResponse(404, { error: 'not found' });
      if (methodOf(call) === 'selectQuery') return jsonResponse(200, []);
      return jsonResponse(200, {});
    };
    const { linkedPackage } = await import('@_linked/core/utils/Package');
    const { createNameSpace } = await import('@_linked/core/utils/NameSpace');
    linkedPackage('remote-graph-fallback-test').linkedOntology(
      {},
      createNameSpace('http://example.org/fallback/'),
      'fallback',
      async () => ['<http://example.org/fallback/B> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/fallback/A> .'],
      '../data/fallback.ttl',
    );
    const result = await syncOntologies(new RemoteDataset({ url: URL_BASE }), {
      packages: ['remote-graph-fallback-test'],
    });
    expect(result.written).toEqual(['remote-graph-fallback-test']);
    expect(methods).toContain('graphQuery');
    // The default-graph sync wrote the hierarchy with ordinary queries after the refusal.
    expect(methods.slice(methods.indexOf('graphQuery') + 1)).toEqual(
      expect.arrayContaining(['updateQuery']),
    );
  });
});

describe('RemoteDataset: reads from graphs and the registry cache', () => {
  async function store(dataset = 'app-data-main') {
    const ds = new RemoteDataset({ url: URL_BASE, token: TOKEN });
    await ds.init();
    expect(ds.info?.dataset).toBe(dataset);
    return ds;
  }

  it('expands graphs.allOntologies from one registry read, sorted, and keeps other names', async () => {
    const plane = stubPlane({ ontology: [G_B, G_A], shapes: [G_S] });
    const ds = await store();
    await ds.selectQuery(queryJson({ v: '1.1', shape: 'http://e/S', graphs: [graphs.allOntologies, 'http://e/g'] }));
    await ds.askQuery(queryJson({ v: '1.1', graphs: [graphs.allShapes] }));
    expect(plane.readGraphs).toEqual([[G_A, G_B, 'http://e/g'], [G_S]]);
    expect(plane.registryReads.sort()).toEqual(['ontology', 'shapes']);
  });

  it('sends a read without graphs, or with names it does not expand, untouched and reads no registry', async () => {
    const plane = stubPlane({ ontology: [G_A], shapes: [] });
    const ds = await store();
    await ds.selectQuery(queryJson({ v: '1.1', shape: 'http://e/S' }));
    await ds.selectQuery(queryJson({ v: '1.1', shape: 'http://e/S', graphs: [graphs.union] }));
    expect(plane.readGraphs).toEqual([undefined, [graphs.union]]);
    expect(plane.registryReads).toEqual([]);
  });

  it('sends a name that expands to no graph as is, for the data server to answer', async () => {
    const plane = stubPlane({ ontology: [], shapes: [] });
    const ds = await store();
    await ds.selectQuery(queryJson({ v: '1.1', shape: 'http://e/S', graphs: [graphs.allOntologies] }));
    expect(plane.readGraphs).toEqual([[graphs.allOntologies]]);
  });

  it('its own graph queries update the cache: the next read sees the change without a re-read', async () => {
    const plane = stubPlane({ ontology: [G_A], shapes: [] });
    const ds = await store();
    const read = () => ds.selectQuery(queryJson({ v: '1.1', shape: 'http://e/S', graphs: [graphs.allOntologies] }));
    await read();
    await ds.graphQuery({ ...replace, kind: 'graph_create', graph: G_B });
    await read();
    await ds.graphQuery({ kind: 'graph_drop', graph: G_A, recordClass: OntologyGraph.targetClass.id });
    await read();
    expect(plane.readGraphs).toEqual([[G_A], [G_A, G_B], [G_B]]);
    expect(plane.registryReads.filter((k) => k === 'ontology')).toHaveLength(1);
  });

  it('is keyed by the dataset the server named: a pushed invalidation of that name forces a re-read', async () => {
    const plane = stubPlane({ ontology: [G_A], shapes: [] }, 'app-data-p1-main');
    const ds = await store('app-data-p1-main');
    const read = () => ds.selectQuery(queryJson({ v: '1.1', shape: 'http://e/S', graphs: [graphs.allOntologies] }));
    await read();
    await read();
    invalidateGraphRegistry('some-other-dataset');
    await read();
    expect(plane.registryReads.filter((k) => k === 'ontology')).toHaveLength(1);
    invalidateGraphRegistry('app-data-p1-main');
    await read();
    expect(plane.registryReads.filter((k) => k === 'ontology')).toHaveLength(2);
    ds.invalidateGraphRegistry();
    await read();
    expect(plane.registryReads.filter((k) => k === 'ontology')).toHaveLength(3);
  });

  it('re-reads an entry older than 30 seconds', async () => {
    const plane = stubPlane({ ontology: [G_A], shapes: [] });
    const ds = await store();
    const read = () => ds.selectQuery(queryJson({ v: '1.1', shape: 'http://e/S', graphs: [graphs.allOntologies] }));
    const realNow = Date.now;
    const start = realNow();
    try {
      Date.now = () => start;
      await read();
      Date.now = () => start + GRAPH_REGISTRY_MAX_AGE_MS;
      await read();
      Date.now = () => start + GRAPH_REGISTRY_MAX_AGE_MS + 1;
      await read();
    } finally {
      Date.now = realNow;
    }
    expect(plane.registryReads.filter((k) => k === 'ontology')).toHaveLength(2);
  });

  it('the no-url form sends graphs unchanged: the backend expands them', async () => {
    const seen: unknown[] = [];
    (Server as any).call = async (_pkg: string, config: any, json: any) => {
      seen.push([config.method, json.graphs]);
      return [];
    };
    await new RemoteDataset().selectQuery(queryJson({ v: '1.1', shape: 'http://e/S', graphs: [graphs.allOntologies] }));
    expect(seen).toEqual([['selectQuery', [graphs.allOntologies]]]);
  });
});
