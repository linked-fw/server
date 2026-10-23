import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';

// Graph queries on the generic query plane, through the real call routes: core's
// `parseGraphQuery` checks the body, the routed store's `graph` rule decides (no rule refuses),
// `LinkedStorage.graphQuery` runs it, and a store's refusal goes back as `{error, code}`, which
// `RemoteDataset` turns back into a `GraphQueryError`. Plus the control channel's
// `POST /admin/graph-registry-changed`.

process.env.SITE_ROOT ??= 'http://app.test:4000';
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
const { withAccess } = await import('@_linked/server-utils/utils/QueryAccess');
const { LinkedServer, registerCallRoutes } = await import('../shapes/LinkedServer.js');
const { default: LincdServerBackendProvider } = await import('../backend.js');
const { createJsonBodyParser } = await import('../utils/jsonBodyParser.js');
const { RemoteDataset, RemoteDatasetUnauthorizedError } = await import('../shapes/quadstores/RemoteDataset.js');
const { registerAdminRoutes, parseGraphRegistryChangedBody, AdminRequestError } = await import(
  '../utils/adminChannel.js'
);
const { GraphQueryError, isGraphQueryError } = await import('@_linked/core/queries/graphQuery');
const { graphs } = await import('@_linked/core/ontologies/graphs');
const { invalidateGraphRegistry } = await import('@_linked/core/utils/graphRegistryCache');
const { OntologyGraph, DraftGraph } = await import('@_linked/core/shapes/NamedGraph');

const G = 'https://linked.cm/pkg/a/graph/ontology';
const ONTOLOGY_CLASS = OntologyGraph.targetClass.id;
const ONTOLOGY_SHAPE = OntologyGraph.shape.id;
const ME = 'http://ex/me';
const SECRET = 'graph-admin-secret';
const BODY = { mediaType: 'application/n-triples', text: '<http://e/s> <http://e/p> <http://e/o> .\n' };

const queries = {
  graph_create: { kind: 'graph_create', graph: G, recordClass: ONTOLOGY_CLASS, record: { package: 'a' }, content: BODY },
  graph_replace: { kind: 'graph_replace', graph: G, recordClass: ONTOLOGY_CLASS, content: BODY },
  graph_patch: { kind: 'graph_patch', graph: G, recordClass: ONTOLOGY_CLASS, patch: { insert: BODY } },
  graph_drop: { kind: 'graph_drop', graph: G, recordClass: ONTOLOGY_CLASS },
} as const;

/** A store that records the graph queries it runs and counts the registry reads it answers. */
function fakeStore(registry: string[] = [G]) {
  const ran: any[] = [];
  const registryReads: number[] = [];
  const reads: unknown[] = [];
  let refusal: Error | undefined;
  const store = {
    ran,
    registryReads,
    reads,
    refuseWith(err: Error | undefined) {
      refusal = err;
    },
    async graphQuery(q: any) {
      if (refusal) throw refusal;
      ran.push(q);
      return { graph: q.graph, changed: true, contentHash: 'h', modified: '2026-10-23T00:00:00.000Z' };
    },
    async selectQuery(q: any) {
      const json = q.toJSON();
      if (json.shape === ONTOLOGY_SHAPE) {
        registryReads.push(1);
        return registry.map((id) => ({ id }));
      }
      reads.push(json.graphs);
      return [];
    },
    async askQuery() {
      return false;
    },
    async createQuery() {
      return {};
    },
    async updateQuery() {
      return {};
    },
    async deleteQuery() {
      return {};
    },
  };
  return store;
}

const servers: any[] = [];
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  jest.restoreAllMocks();
  invalidateGraphRegistry();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function makeLinkedServer(): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.genericProviders = new Map();
  server.shapeProviders = new Map();
  server.providerIndexing = new Map();
  server.initRequest = async () => {};
  server.genericProviders.set('@_linked/server', new LincdServerBackendProvider({}, server));
  return server;
}

async function listen(adminSecret?: string): Promise<string> {
  const app = express();
  app.use(createJsonBodyParser());
  app.use((req: any, _res, next) => {
    const user = req.headers['x-test-user'];
    if (user) req.linkedAuth = { userAccount: { id: user } };
    next();
  });
  registerCallRoutes(app, makeLinkedServer());
  if (adminSecret) registerAdminRoutes(app as any, adminSecret, { exit: () => {}, syncShapes: async () => ({ written: 0 }) });
  const s = await new Promise<any>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const graphCall = (base: string, query: unknown, user?: string) =>
  post(`${base}/call/@_linked/server/graphQuery`, { args: [query] }, user ? { 'x-test-user': user } : {});

describe('the generic plane: graphQuery', () => {
  it('refuses every kind without a graph rule (403), signed in or not, and never runs it', async () => {
    const store = fakeStore();
    LinkedStorage.setDefaultDataset(withAccess(store, { read: 'session', write: 'session' }) as any);
    const base = await listen();
    for (const q of Object.values(queries)) {
      expect((await graphCall(base, q, ME)).status).toBe(403);
      expect((await graphCall(base, q)).status).toBe(403);
    }
    LinkedStorage.setDefaultDataset(withAccess(store, { read: 'session', write: 'session', graph: 'none' }) as any);
    expect((await graphCall(base, queries.graph_replace, ME)).status).toBe(403);
    expect(store.ran).toHaveLength(0);
  });

  it('runs every kind the rule allows and answers the store’s result; the rule sees the query', async () => {
    const store = fakeStore();
    const seen: any[] = [];
    LinkedStorage.setDefaultDataset(
      withAccess(store, {
        read: 'session',
        write: 'session',
        graph: (ctx: any) => {
          seen.push(ctx);
          return ctx.recordClass === ONTOLOGY_CLASS && !!ctx.linkedAuth;
        },
      }) as any,
    );
    const base = await listen();
    for (const q of Object.values(queries)) {
      const res = await graphCall(base, q, ME);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ graph: G, changed: true, contentHash: 'h', modified: '2026-10-23T00:00:00.000Z' });
    }
    expect(store.ran).toEqual(Object.values(queries));
    expect(seen[0]).toMatchObject({
      operation: 'graph',
      kind: 'graph_create',
      graph: G,
      recordClass: ONTOLOGY_CLASS,
      ir: queries.graph_create,
      store,
    });
    expect(seen[0].linkedAuth.userAccount.id).toBe(ME);
    // A draft record: the rule decides by record class.
    const draft = { ...queries.graph_drop, recordClass: DraftGraph.targetClass.id };
    expect((await graphCall(base, draft, ME)).status).toBe(403);
  });

  it('answers 400 for a malformed graph query and for a graph query on a shape query endpoint', async () => {
    const store = fakeStore();
    LinkedStorage.setDefaultDataset(withAccess(store, { read: 'session', write: 'session', graph: () => true }) as any);
    const base = await listen();
    expect((await graphCall(base, { kind: 'graph_replace', graph: G, recordClass: ONTOLOGY_CLASS }, ME)).status).toBe(400);
    expect((await graphCall(base, { kind: 'graph_drop', graph: 'relative', recordClass: ONTOLOGY_CLASS }, ME)).status).toBe(400);
    expect((await graphCall(base, { v: '1.1', shape: ONTOLOGY_SHAPE }, ME)).status).toBe(400);
    for (const method of ['selectQuery', 'updateQuery', 'createQuery', 'deleteQuery', 'askQuery']) {
      const res = await post(`${base}/call/@_linked/server/${method}`, { args: [queries.graph_drop] }, { 'x-test-user': ME });
      expect(res.status).toBe(400);
    }
    expect(store.ran).toHaveLength(0);
  });

  it('answers a store’s refusal with its status and code', async () => {
    const store = fakeStore();
    LinkedStorage.setDefaultDataset(withAccess(store, { read: 'session', write: 'session', graph: () => true }) as any);
    const base = await listen();
    const cases: Array<[string, number]> = [
      ['graph-exists', 409],
      ['graph-not-registered', 409],
      ['graph-name-read-only', 400],
      ['unsupported-query-kind', 501],
    ];
    for (const [code, status] of cases) {
      store.refuseWith(new GraphQueryError(code as any, `refused ${code}`, G));
      const res = await graphCall(base, queries.graph_create, ME);
      expect(res).toEqual({ status, json: { error: `refused ${code}`, code } });
    }
    store.refuseWith(new Error('store down'));
    const failed = await graphCall(base, queries.graph_create, ME);
    expect(failed.status).toBe(500);
    expect(failed.json.code).toBeUndefined();
  });
});

describe('a store built against an older core (no graphQuery)', () => {
  it('answers 501 unsupported-query-kind, and RemoteDataset reads it as that refusal', async () => {
    const store: any = fakeStore();
    delete store.graphQuery;
    LinkedStorage.setDefaultDataset(withAccess(store, { read: () => true, write: 'none', graph: () => true }) as any);
    const base = await listen();
    const res = await graphCall(base, queries.graph_replace, ME);
    expect(res.status).toBe(501);
    expect(res.json.code).toBe('unsupported-query-kind');
    const err = await new RemoteDataset({ url: base }).graphQuery(queries.graph_replace as any).catch((e) => e);
    expect(isGraphQueryError(err, 'unsupported-query-kind')).toBe(true);
  });
});

describe('RemoteDataset against the plane', () => {
  it('sends graph_replace, gets the result, and gets refusals back as GraphQueryErrors', async () => {
    const store = fakeStore();
    LinkedStorage.setDefaultDataset(withAccess(store, { read: () => true, write: 'none', graph: () => true }) as any);
    const base = await listen();
    const remote = new RemoteDataset({ url: base });
    await remote.init();
    const result = await remote.graphQuery(queries.graph_replace as any);
    expect(result.graph).toBe(G);
    expect(store.ran).toEqual([queries.graph_replace]);
    store.refuseWith(new GraphQueryError('graph-not-registered', 'no record', G));
    const err = await remote.graphQuery(queries.graph_replace as any).catch((e) => e);
    expect(isGraphQueryError(err, 'graph-not-registered')).toBe(true);
  });

  it('is refused (403) where the store has no graph rule', async () => {
    const store = fakeStore();
    LinkedStorage.setDefaultDataset(withAccess(store, { read: () => true, write: 'none' }) as any);
    const base = await listen();
    const err = await new RemoteDataset({ url: base }).graphQuery(queries.graph_drop as any).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteDatasetUnauthorizedError);
  });
});

describe('POST /admin/graph-registry-changed', () => {
  it('refuses a missing or wrong secret and a body without a dataset', async () => {
    const base = await listen(SECRET);
    const url = `${base}/admin/graph-registry-changed`;
    expect((await post(url, { dataset: 'd' })).status).toBe(401);
    expect((await post(url, { dataset: 'd' }, { 'x-cn-admin-secret': 'wrong' })).status).toBe(401);
    expect((await post(url, {}, { 'x-cn-admin-secret': SECRET })).status).toBe(400);
    expect((await post(url, { dataset: '  ' }, { 'x-cn-admin-secret': SECRET })).status).toBe(400);
    expect(() => parseGraphRegistryChangedBody({ dataset: 3 })).toThrow(AdminRequestError);
    expect(parseGraphRegistryChangedBody({ dataset: ' app-data ' })).toEqual({ dataset: 'app-data' });
  });

  it('is absent (404) without a configured secret', async () => {
    const app = express();
    app.use(express.json());
    registerAdminRoutes(app, undefined, { exit: () => {}, syncShapes: async () => ({ written: 0 }) });
    const s = await new Promise<any>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    servers.push(s);
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    expect((await post(`${base}/admin/graph-registry-changed`, { dataset: 'd' }, { 'x-cn-admin-secret': SECRET })).status).toBe(404);
  });

  it('with the secret, the next .from(graphs.allOntologies) read re-reads the registry', async () => {
    const store = fakeStore();
    LinkedStorage.setDefaultDataset(withAccess(store, { read: () => true, write: 'none', graph: () => true }) as any);
    const base = await listen(SECRET);
    const remote = new RemoteDataset({ url: base });
    await remote.init();
    const read = () =>
      remote.selectQuery({ toJSON: () => ({ v: '1.1', shape: ONTOLOGY_SHAPE.replace('OntologyGraph', 'NamedGraph'), graphs: [graphs.allOntologies] }) } as any);
    await read();
    await read();
    expect(store.registryReads).toHaveLength(1);
    const refused = await post(`${base}/admin/graph-registry-changed`, { dataset: 'app-data-main' });
    expect(refused.status).toBe(401);
    await read();
    expect(store.registryReads).toHaveLength(1);
    const res = await post(`${base}/admin/graph-registry-changed`, { dataset: 'app-data-main' }, { 'x-cn-admin-secret': SECRET });
    expect(res).toEqual({ status: 200, json: { invalidated: 'app-data-main' } });
    await read();
    expect(store.registryReads).toHaveLength(2);
    // The shapes-graph records are read beside them (no graphs field); the reads sent the expanded set.
    expect(store.reads.filter(Boolean)).toEqual([[G], [G], [G], [G]]);
  });
});
