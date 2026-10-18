import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';
import { Shape } from '@_linked/core/shapes/Shape';
import { literalProperty } from '@_linked/core/shapes/SHACL';
import { linkedPackage } from '@_linked/core/utils/Package';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { SparqlDataset } from '@_linked/core/sparql/SparqlDataset';
import { SelectBuilder } from '@_linked/core/queries/QueryBuilder';
import { CreateBuilder } from '@_linked/core/queries/CreateBuilder';
import {
  ShapeCatalog,
  catalogOf,
  getActiveShapeCatalog,
  withShapeCatalog,
} from '@_linked/core/utils/ShapeCatalog';
import type { NodeShapeWire } from '@_linked/core/shapes/nodeShapeWire';
import { shacl } from '@_linked/core/ontologies/shacl';
import { withAccess } from '@_linked/server-utils/utils/QueryAccess';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { LinkedServer, registerCallRoutes } from '../shapes/LinkedServer.js';
import { LincdAPI } from '../shapes/LincdAPI.js';
import LincdServerBackendProvider from '../backend.js';
import { createJsonBodyParser } from '../utils/jsonBodyParser.js';
import { setRpcExposureMode } from '../utils/rpcExposure.js';
import {
  resolveQueryCatalog,
  setQueryCatalogResolver,
  toQueryBuilder,
} from '../utils/queryPlane.js';

// The query plane's catalog hook: the host supplies the shape catalog each
// generic query request is decoded in, driven through the real routes.

const EX = 'http://example.org/catalog-plane/';
const PROJECT_PERSON = `${EX}shape/ProjectPerson`;
const NAME_PATH = `${EX}name`;
const SECRET_PATH = `${EX}secret`;
const SECRET_PROP = `${PROJECT_PERSON}/secret`;

/** A shape that exists only as data, in the catalog: no class, never registered. */
const personWire: NodeShapeWire = {
  id: PROJECT_PERSON,
  label: 'ProjectPerson',
  targetClass: { id: `${EX}Person` },
  propertyShapes: [
    { id: `${PROJECT_PERSON}/name`, label: 'name', path: { id: NAME_PATH }, maxCount: 1, nodeKind: { id: shacl.Literal.id } },
    { id: SECRET_PROP, label: 'secret', path: { id: SECRET_PATH }, maxCount: 1, nodeKind: { id: shacl.Literal.id } },
  ],
} as NodeShapeWire;

const catalog = ShapeCatalog.from([personWire], { name: 'project#main' });

/** A registered (global) shape, to show the global path is unchanged. */
const { linkedShape } = linkedPackage('query-plane-catalog-test');
@linkedShape({ name: 'GlobalNote' })
class GlobalNote extends Shape {
  static targetClass = { id: `${EX}Note` };
  @literalProperty({ path: { id: `${EX}text` }, maxCount: 1 })
  get text(): string {
    return '';
  }
}

const selectJson = (field: 'name' | 'secret' = 'name') =>
  withShapeCatalog(catalog, () =>
    SelectBuilder.from(PROJECT_PERSON).select((p: any) => [p[field]]).toJSON()
  );
const createJson = () =>
  withShapeCatalog(catalog, () =>
    CreateBuilder.from(PROJECT_PERSON).set({ name: 'x' } as any).toJSON()
  );

/** A SPARQL dataset that records what it is asked, and what each builder captured. */
class RecordingSparql extends (SparqlDataset as any) {
  sparql: string[] = [];
  builders: any[] = [];
  calledIn: Array<ShapeCatalog | undefined> = [];
  constructor() {
    super({} as any);
  }
  selectQuery(q: any) {
    this.builders.push(q);
    this.calledIn.push(getActiveShapeCatalog());
    return super.selectQuery(q);
  }
  createQuery(q: any) {
    this.builders.push(q);
    return super.createQuery(q);
  }
  async executeSparqlSelect(q: string) {
    this.sparql.push('SELECT:: ' + q);
    return { head: { vars: [] }, results: { bindings: [] } };
  }
  async executeSparqlUpdate(q: string) {
    this.sparql.push('UPDATE:: ' + q);
  }
  async init() {}
}

const ME = 'http://ex/u';
const servers: any[] = [];
let ds: RecordingSparql;
let errorLog: any;

beforeEach(() => {
  ds = new RecordingSparql();
  LinkedStorage.setDefaultDataset(ds as any);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  setQueryCatalogResolver(undefined);
  setRpcExposureMode(undefined);
  jest.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

function makeLinkedServer(): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.genericProviders = new Map();
  server.shapeProviders = new Map();
  server.providerIndexing = new Map();
  server.initRequest = async () => {};
  server.genericProviders.set('@_linked/server', new LincdServerBackendProvider({}, server));
  server.api = new LincdAPI({ id: 'http://example.org/api' });
  return server;
}

async function listen(): Promise<string> {
  const app = express();
  app.use(createJsonBodyParser());
  // stands in for the auth provider's session middleware
  app.use((req: any, _res, next) => {
    const user = req.headers['x-test-user'];
    if (user) req.linkedAuth = { userAccount: { id: user } };
    next();
  });
  registerCallRoutes(app, makeLinkedServer());
  const s = await new Promise<any>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function post(url: string, body: unknown, user = ME) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const call = (base: string, method: string, json: unknown) =>
  post(`${base}/call/@_linked/server/${method}`, { args: [json] });
const api = (base: string, action: string, json: unknown) =>
  post(`${base}/api/${action}`, { query: json });

describe('query-plane catalog resolver', () => {
  it('is called once per request with the JSON, and the query decodes in its catalog', async () => {
    const seen: unknown[] = [];
    setQueryCatalogResolver((q) => (seen.push(q), catalog));
    const base = await listen();
    const json = selectJson();

    const res = await call(base, 'selectQuery', json);
    expect(res.status).toBe(200);
    expect(seen).toEqual([json]);
    expect(ds.builders).toHaveLength(1);
    expect(catalogOf(ds.builders[0])).toBe(catalog);
    // the dataset is called outside the catalog; the compile re-enters it
    expect(ds.calledIn).toEqual([undefined]);
    expect(ds.sparql).toHaveLength(1);
    expect(ds.sparql[0]).toContain(NAME_PATH);

    expect((await api(base, 'select', json)).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(catalogOf(ds.builders[1])).toBe(catalog);
  });

  it('decodes a mutation in its catalog, compiled after the store awaits', async () => {
    setQueryCatalogResolver(async () => catalog);
    const base = await listen();
    expect((await call(base, 'createQuery', createJson())).status).toBe(200);
    expect((await api(base, 'create', createJson())).status).toBe(200);
    const updates = ds.sparql.filter((q) => q.startsWith('UPDATE::'));
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u).toContain(NAME_PATH);
  });

  it('a resolver answering undefined decodes in the global registry', async () => {
    setQueryCatalogResolver(() => undefined);
    const base = await listen();
    const json = (GlobalNote as any).select((n: any) => n.text).toJSON();
    expect((await call(base, 'selectQuery', json)).status).toBe(200);
    expect(catalogOf(ds.builders[0])).toBeUndefined();
    // a catalog-only shape is unknown there
    expect((await call(base, 'selectQuery', selectJson())).status).toBe(400);
  });
});

describe('without a resolver', () => {
  it('behaves as before: global shapes answer, a catalog-only shape is an invalid query', async () => {
    const base = await listen();
    const json = (GlobalNote as any).select((n: any) => n.text).toJSON();
    expect((await call(base, 'selectQuery', json)).status).toBe(200);
    expect((await api(base, 'select', json)).status).toBe(200);
    expect(catalogOf(ds.builders[0])).toBeUndefined();
    const unknown = await call(base, 'selectQuery', selectJson());
    expect(unknown).toEqual({ status: 400, json: { error: 'Invalid query' } });
    expect((await api(base, 'select', selectJson())).status).toBe(400);
    await expect(resolveQueryCatalog(json)).resolves.toBeUndefined();
  });
});

describe('a live builder from backend code', () => {
  it('passes through without asking the resolver', async () => {
    const resolver = jest.fn(() => catalog);
    setQueryCatalogResolver(resolver);
    const builder = withShapeCatalog(catalog, () =>
      SelectBuilder.from(PROJECT_PERSON).select((p: any) => [p.name])
    );
    expect(toQueryBuilder(builder)).toBe(builder);
    await expect(resolveQueryCatalog(builder)).resolves.toBeUndefined();
    const provider = new LincdServerBackendProvider({} as any, {} as any);
    await provider.selectQuery(builder);
    expect(resolver).not.toHaveBeenCalled();
    expect(ds.builders).toEqual([builder]);
    expect(ds.sparql[0]).toContain(NAME_PATH);
  });
});

describe('a resolver that throws', () => {
  it('answers 500 "Shape catalog unavailable" and logs the cause', async () => {
    setQueryCatalogResolver(() => {
      throw new Error('store down');
    });
    const base = await listen();
    expect(await call(base, 'selectQuery', selectJson())).toEqual({
      status: 500,
      json: { error: 'Shape catalog unavailable' },
    });
    expect(await api(base, 'select', selectJson())).toEqual({
      status: 500,
      json: { error: 'Shape catalog unavailable' },
    });
    expect(errorLog.mock.calls.some((c: any[]) => c.some((a) => a?.message === 'store down'))).toBe(true);
    expect(ds.sparql).toHaveLength(0);
  });

  it('passes a ServerCallError on with its status', async () => {
    setQueryCatalogResolver(async () => {
      throw new ServerCallError(404, 'No such branch');
    });
    const base = await listen();
    expect(await call(base, 'selectQuery', selectJson())).toEqual({
      status: 404,
      json: { error: 'No such branch' },
    });
    expect((await api(base, 'select', selectJson())).status).toBe(404);
    expect(ds.sparql).toHaveLength(0);
  });
});

describe('the access check', () => {
  it('lowers in the same catalog: a rule on a catalog-only property applies', async () => {
    const seenShapes: string[][] = [];
    withAccess(ds, {
      read: (ctx) => {
        seenShapes.push([...ctx.shapes]);
        return !ctx.propertyShapes.has(SECRET_PROP);
      },
    });
    setQueryCatalogResolver(() => catalog);
    const base = await listen();
    expect((await call(base, 'selectQuery', selectJson('secret'))).status).toBe(403);
    expect((await api(base, 'select', selectJson('secret'))).status).toBe(403);
    expect(ds.sparql).toHaveLength(0);
    expect((await call(base, 'selectQuery', selectJson('name'))).status).toBe(200);
    expect(seenShapes.every((s) => s.includes(PROJECT_PERSON))).toBe(true);
    expect(ds.sparql).toHaveLength(1);
  });
});
