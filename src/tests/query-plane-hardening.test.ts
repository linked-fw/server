import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';
import { Shape } from '@_linked/core/shapes/Shape';
import { literalProperty, objectProperty } from '@_linked/core/shapes/SHACL';
import { linkedPackage } from '@_linked/core/utils/Package';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';
import { callable, declareInternal, internal } from '@_linked/server-utils/utils/callable';
import { getCallContext } from '@_linked/server-utils/utils/CallContext';
import { registerProtectedShapes } from '@_linked/server-utils/utils/QueryAccess';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { LinkedServer, registerCallRoutes } from '../shapes/LinkedServer.js';
import { LincdAPI } from '../shapes/LincdAPI.js';
import LincdServerBackendProvider from '../backend.js';
import { createJsonBodyParser } from '../utils/jsonBodyParser.js';
import {
  resetUndeclaredWarnings,
  resolveCallable,
  setRpcExposureMode,
} from '../utils/rpcExposure.js';

// Regression tests for the generic query plane and request context, driven
// through the real routes (registerCallRoutes) and the real JSON body parser.

const { linkedShape } = linkedPackage('query-plane-hardening-test');
const NS = 'http://example.org/hardening-test/';

@linkedShape({ name: 'HardenedSecret' })
class RpcSecret extends Shape {
  static targetClass = { id: NS + 'Secret' };
  @literalProperty({ path: { id: NS + 'token' }, maxCount: 1 })
  get token(): string {
    return '';
  }
}

@linkedShape({ name: 'HardenedPerson' })
class RpcPerson extends Shape {
  static targetClass = { id: NS + 'Person' };
  @literalProperty({ path: { id: NS + 'name' }, maxCount: 1 })
  get name(): string {
    return '';
  }
  @objectProperty({ path: { id: NS + 'secret' }, shape: RpcSecret, maxCount: 1 })
  get secret(): RpcSecret {
    return null as any;
  }
  @objectProperty({ path: { id: NS + 'friend' }, shape: RpcPerson })
  get friends(): any {
    return null;
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class TestProvider extends BackendProvider {
  @callable('public')
  ping() {
    return 'pong';
  }

  @callable('user')
  whoami() {
    return this.request?.linkedAuth?.userAccount?.id;
  }

  @callable('user')
  async slowWhoami(delay: number) {
    await tick(delay);
    return this.request?.linkedAuth?.userAccount?.id;
  }

  undeclared() {
    return 'ran';
  }

  @internal()
  secret() {
    return 'secret';
  }

  // declared both ways: internal wins
  @callable('public')
  @internal()
  bothWays() {
    return 'both';
  }

  @callable('public')
  async nestedSecret() {
    // a backend-to-backend call to an internal method while serving a request
    return (this.lincdServer as any).callBackendMethod('pkg', 'secret', []);
  }

  @callable('public')
  echo(arg: any) {
    return {
      type: typeof arg?.value,
      prototypeIsObject: Object.getPrototypeOf(arg ?? {}) === Object.prototype,
      isAdmin: arg?.isAdmin === true,
    };
  }

  @callable('public')
  contextKind() {
    const ctx = getCallContext();
    return { kind: ctx?.kind, user: (ctx as any)?.request?.linkedAuth?.userAccount?.id };
  }

  @callable('public')
  async nested() {
    // a backend-to-backend call made while serving a request
    return (this.lincdServer as any).callBackendMethod('pkg', 'contextKind', []);
  }

  setupAfterControllers() {}

  dispose() {
    disposed++;
  }
}

let disposed = 0;

class NoRpcProvider extends BackendProvider {
  static rpc = false;
  @callable('public')
  ping() {
    return 'pong';
  }
}

class TestShapeProvider extends ShapeProvider {
  @callable('public')
  ping() {
    return 'shape-pong';
  }

  @internal()
  shapeSecret() {
    return 'shape-secret';
  }
}

const servers: any[] = [];
let warn: any;

beforeEach(() => {
  resetUndeclaredWarnings();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  setRpcExposureMode(undefined);
  registerProtectedShapes([], { deny: 'all', owner: 'rpc-test' });
  registerProtectedShapes([], { deny: 'write', owner: 'rpc-test' });
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
  server.genericProviders.set('pkg', new TestProvider({}, server));
  server.genericProviders.set('norpc', new NoRpcProvider({}, server));
  server.genericProviders.set('@_linked/server', new LincdServerBackendProvider({}, server));
  const shapeProvider = new TestShapeProvider({}, server);
  shapeProvider.shape = LincdAPI as any;
  server.shapeProviders.set('server', [shapeProvider]);
  server.api = new LincdAPI({ id: 'http://example.org/api' });
  return server;
}

async function listen(linkedServer: any): Promise<string> {
  const app = express();
  app.use(createJsonBodyParser());
  // stands in for the auth provider's session middleware
  app.use((req: any, _res, next) => {
    const user = req.headers['x-test-user'];
    if (user) req.linkedAuth = { userAccount: { id: user } };
    next();
  });
  registerCallRoutes(app, linkedServer);
  const s = await new Promise<any>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function post(url: string, body: unknown, user?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const call = (base: string, pkg: string, method: string, args: any[] = [], user?: string) =>
  post(`${base}/call/${pkg}/${method}`, { args }, user);

const shapeCall = (base: string, method: string) =>
  post(`${base}/call/server/LincdAPI/${method}`, {
    shapeURI: (LincdAPI as any).shape.id,
    instanceNode: null,
    args: [],
  });

const undeclaredWarnings = () =>
  warn.mock.calls.filter((c: any[]) => String(c[0]).includes('undeclared RPC'));


import fs from 'fs';
import os from 'os';
import path from 'path';
import { SparqlDataset } from '@_linked/core/sparql/SparqlDataset';
import { registerRawQueryAuthorizer } from '@_linked/server-utils/utils/QueryAccess';
import { runWithCallContext } from '@_linked/server-utils/utils/CallContext';
import { enterRequestContext, mountUploads } from '../shapes/LinkedServer.js';
import { protectedNodeAsk, setProtectedNodeProbe } from '../utils/queryPlane.js';
import { logSafe } from '../utils/rpcExposure.js';

/**
 * A SPARQL dataset that records every query it is sent. An ASK answers `true`
 * when it names one of `protectedIds`, which stands in for those nodes being
 * typed with a protected class in the store.
 */
class CapturingSparql extends (SparqlDataset as any) {
  sparql: string[] = [];
  protectedIds = new Set<string>();
  constructor() {
    super({} as any);
  }
  async executeSparqlSelect(q: string) {
    this.sparql.push('SELECT:: ' + q);
    if (/^\s*ASK/i.test(q)) {
      return { head: {}, boolean: [...this.protectedIds].some((id) => q.includes(`<${id}>`)) };
    }
    return { head: { vars: [] }, results: { bindings: [] } };
  }
  async executeSparqlUpdate(q: string) {
    this.sparql.push('UPDATE:: ' + q);
  }
  async init() {}
  updates() {
    return this.sparql.filter((q) => q.startsWith('UPDATE::'));
  }
  asks() {
    return this.sparql.filter((q) => q.startsWith('SELECT:: ASK'));
  }
}

const rawCleanups: (() => void)[] = [];
afterEach(() => {
  for (const off of rawCleanups.splice(0)) off();
  setProtectedNodeProbe(undefined);
});

const SECRET_ID = 'http://ex/secret1';
const ME = 'http://ex/u';

describe('protected nodes on the generic plane', () => {
  let ds: CapturingSparql;
  beforeEach(() => {
    ds = new CapturingSparql();
    ds.protectedIds.add(SECRET_ID);
    LinkedStorage.setDefaultDataset(ds as any);
    registerProtectedShapes([RpcSecret], { deny: 'write', owner: 'rpc-test' });
  });
  const Person = RpcPerson as any;

  it('refuses deleting a protected node through an unprotected shape', async () => {
    const base = await listen(makeLinkedServer());
    const del = Person.delete(SECRET_ID).toJSON();
    const res = await call(base, '@_linked/server', 'deleteQuery', [del], ME);
    expect(res.status).toBe(403);
    expect(ds.updates()).toHaveLength(0);
    expect(ds.asks()).toHaveLength(1);
    expect(ds.asks()[0]).toContain('rdf-schema#subClassOf>*');
  });

  it('refuses updating a protected node through an unprotected shape', async () => {
    const base = await listen(makeLinkedServer());
    const upd = Person.update({ name: 'pwn' }).for(SECRET_ID).toJSON();
    expect((await call(base, '@_linked/server', 'updateQuery', [upd], ME)).status).toBe(403);
    expect(ds.updates()).toHaveLength(0);
  });

  it('still lets an unprotected node be updated, and links to a protected node', async () => {
    const base = await listen(makeLinkedServer());
    const upd = Person.update({ name: 'ok', secret: { id: SECRET_ID } }).for('http://ex/p1').toJSON();
    expect((await call(base, '@_linked/server', 'updateQuery', [upd], ME)).status).toBe(200);
    expect(ds.updates()).toHaveLength(1);
    const del = Person.delete('http://ex/p1').toJSON();
    expect((await call(base, '@_linked/server', 'deleteQuery', [del], ME)).status).toBe(200);
  });

  it('refuses a create that chooses its id', async () => {
    const base = await listen(makeLinkedServer());
    const create = Person.create({ __id: SECRET_ID, name: 'x' }).toJSON();
    expect((await call(base, '@_linked/server', 'createQuery', [create], ME)).status).toBe(403);
    const other = Person.create({ __id: 'http://ex/fresh', name: 'x' }).toJSON();
    expect((await call(base, '@_linked/server', 'createQuery', [other], ME)).status).toBe(403);
    expect((await post(`${base}/api/create`, { query: other }, ME)).status).toBe(403);
    expect(ds.updates()).toHaveLength(0);
    // a create without an id is fine
    const plain = Person.create({ name: 'x' }).toJSON();
    expect((await call(base, '@_linked/server', 'createQuery', [plain], ME)).status).toBe(200);
  });

  it('applies the same check on /api/update and /api/delete', async () => {
    const base = await listen(makeLinkedServer());
    const del = Person.delete(SECRET_ID).toJSON();
    expect((await post(`${base}/api/delete`, { query: del }, ME)).status).toBe(403);
    const upd = Person.update({ name: 'pwn' }).for(SECRET_ID).toJSON();
    expect((await post(`${base}/api/update`, { query: upd }, ME)).status).toBe(403);
    expect(ds.updates()).toHaveLength(0);
  });

  it('refuses when the store cannot run the check', async () => {
    LinkedStorage.setDefaultDataset({
      init: async () => {},
      selectQuery: async () => [],
      createQuery: async () => ({}),
      updateQuery: async () => ({}),
      deleteQuery: async () => ({}),
      askQuery: async () => false,
    } as any);
    const base = await listen(makeLinkedServer());
    const upd = Person.update({ name: 'x' }).for('http://ex/p1').toJSON();
    expect((await call(base, '@_linked/server', 'updateQuery', [upd], ME)).status).toBe(403);
  });

  it('uses a probe the app sets', async () => {
    const seen: any[] = [];
    setProtectedNodeProbe(async (check) => (seen.push(check), false));
    const base = await listen(makeLinkedServer());
    const del = Person.delete(SECRET_ID).toJSON();
    expect((await call(base, '@_linked/server', 'deleteQuery', [del], ME)).status).toBe(200);
    expect(seen[0].ids).toEqual([SECRET_ID]);
    expect(ds.asks()).toHaveLength(0);
  });
});

describe('protectedNodeAsk', () => {
  const base = {
    operation: 'delete' as const,
    shape: 'http://ex/shape',
    ids: [] as string[],
    ownerIds: [] as string[],
    scanClasses: [] as string[],
    classes: ['http://ex/C'],
    containsPredicates: [] as string[],
  };

  it('asks about ids, owned subtrees and co-typed instances', () => {
    const q = protectedNodeAsk({
      ...base,
      ids: ['http://ex/a'],
      ownerIds: ['http://ex/a'],
      scanClasses: ['http://ex/Person'],
      containsPredicates: ['http://ex/owns', 'http://ex/has'],
    })!;
    expect(q).toContain('VALUES ?n { <http://ex/a> }');
    expect(q).toContain('?owner (<http://ex/owns>|<http://ex/has>)+ ?n');
    expect(q).toContain('?n <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://ex/Person>');
    expect(q).toContain('VALUES ?c { <http://ex/C> }');
  });

  it('asks nothing when there is nothing to check', () => {
    expect(protectedNodeAsk(base)).toBeUndefined();
    expect(protectedNodeAsk({ ...base, ids: ['http://ex/a'], classes: [] })).toBeUndefined();
  });

  it('refuses ids that are not plain IRIs', () => {
    for (const bad of ['http://ex/a> } ; DROP ALL ; {', 'not an iri', 'http://ex/a\nb', 'http://ex/"x']) {
      expect(() => protectedNodeAsk({ ...base, ids: [bad] })).toThrow(/Invalid node id/);
    }
  });
});

describe('mutations need a session', () => {
  let ds: CapturingSparql;
  beforeEach(() => {
    ds = new CapturingSparql();
    LinkedStorage.setDefaultDataset(ds as any);
  });
  const Person = RpcPerson as any;

  it('refuses anonymous create/update/delete in warn mode', async () => {
    const base = await listen(makeLinkedServer());
    const create = Person.create({ name: 'x' }).toJSON();
    const upd = Person.update({ name: 'x' }).for('http://ex/p1').toJSON();
    const del = Person.delete('http://ex/p1').toJSON();
    expect((await call(base, '@_linked/server', 'createQuery', [create])).status).toBe(401);
    expect((await call(base, '@_linked/server', 'updateQuery', [upd])).status).toBe(401);
    expect((await call(base, '@_linked/server', 'deleteQuery', [del])).status).toBe(401);
    expect((await post(`${base}/api/delete`, { query: del })).status).toBe(401);
    expect(ds.updates()).toHaveLength(0);
    // reads stay a warning in warn mode
    const sel = Person.select((p: any) => p.name).toJSON();
    expect((await call(base, '@_linked/server', 'selectQuery', [sel])).status).toBe(200);
  });
});

describe('query kind and parsing', () => {
  let ds: CapturingSparql;
  beforeEach(() => {
    ds = new CapturingSparql();
    LinkedStorage.setDefaultDataset(ds as any);
  });

  it('refuses a mutation sent to selectQuery or askQuery', async () => {
    const base = await listen(makeLinkedServer());
    const del = (RpcSecret as any).delete('http://ex/s1').toJSON();
    expect((await call(base, '@_linked/server', 'selectQuery', [del], ME)).status).toBe(400);
    expect((await call(base, '@_linked/server', 'askQuery', [del], ME)).status).toBe(400);
    expect((await post(`${base}/api/select`, { query: del }, ME)).status).toBe(400);
    expect(ds.sparql).toHaveLength(0);
  });

  it('refuses a body that is not a query (400), on /call and /api', async () => {
    const base = await listen(makeLinkedServer());
    expect((await call(base, '@_linked/server', 'selectQuery', [{ nonsense: true }], ME)).status).toBe(400);
    expect((await post(`${base}/api/select`, { query: { nonsense: true } }, ME)).status).toBe(400);
    expect((await post(`${base}/api/select`, { query: { __queryKind: 'select' } }, ME)).status).toBe(400);
    expect(ds.sparql).toHaveLength(0);
  });

  it('/api/select hands the store the builder it checked', async () => {
    const received: any[] = [];
    LinkedStorage.setDefaultDataset({
      init: async () => {},
      selectQuery: async (q: any) => (received.push(q), []),
      createQuery: async () => ({}),
      updateQuery: async () => ({}),
      deleteQuery: async () => ({}),
      askQuery: async () => false,
    } as any);
    const base = await listen(makeLinkedServer());
    const json = (RpcPerson as any).select((p: any) => p.name).toJSON();
    expect((await post(`${base}/api/select`, { query: json }, ME)).status).toBe(200);
    expect(received).toHaveLength(1);
    expect(Object.getPrototypeOf(received[0])).not.toBe(Object.prototype);
    expect(typeof received[0].__queryKind).toBe('string');
    expect(received[0].toJSON()).toEqual(json);
  });
});

describe('raw SPARQL', () => {
  let ds: CapturingSparql;
  beforeEach(() => {
    ds = new CapturingSparql();
    LinkedStorage.setDefaultDataset(ds as any);
  });
  const q = { query: 'SELECT ?t WHERE { ?s <http://example.org/hardening-test/token> ?t }' };

  it('is refused, anonymous or signed in, in warn mode, despite deny:all', async () => {
    registerProtectedShapes([RpcSecret], { deny: 'all', owner: 'rpc-test' });
    const base = await listen(makeLinkedServer());
    expect((await post(`${base}/api/select-raw`, q)).status).toBe(403);
    expect((await post(`${base}/api/select-raw`, q, ME)).status).toBe(403);
    expect(ds.sparql).toHaveLength(0);
  });

  it('is answered when a raw query authorizer accepts it', async () => {
    const seen: any[] = [];
    rawCleanups.push(
      registerRawQueryAuthorizer(
        (ctx) => {
          seen.push(ctx);
          if (ctx.linkedAuth?.userAccount?.id !== ME) {
            throw new ServerCallError(403, 'Query not permitted');
          }
        },
        { owner: 'rpc-test' }
      )
    );
    const base = await listen(makeLinkedServer());
    expect((await post(`${base}/api/select-raw`, q, ME)).status).toBe(200);
    expect(ds.sparql).toEqual(['SELECT:: ' + q.query]);
    expect(seen[0].query).toBe(q.query);
    expect((await post(`${base}/api/select-raw`, q, 'http://ex/other')).status).toBe(403);
    expect(ds.sparql).toHaveLength(1);
  });
});

describe('request context', () => {
  it('every layer of a request runs in one http context: use, Router and error handlers', async () => {
    const app = express();
    const seen: Record<string, any> = {};
    app.use(enterRequestContext);
    app.use(createJsonBodyParser());
    app.use(enterRequestContext);
    app.use((req: any, _res, next) => {
      seen.use = getCallContext();
      req.linkedAuth = { userAccount: { id: req.headers['x-test-user'] } };
      next();
    });
    const router = express.Router();
    router.post('/r', (req: any, _res, next) => {
      seen.router = getCallContext();
      seen.req = req;
      next(new Error('boom'));
    });
    app.use(router);
    app.use((_err: any, _req: any, res: any, _next: any) => {
      seen.error = getCallContext();
      res.status(500).json({ ok: false });
    });
    const s = await new Promise<any>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    servers.push(s);
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const res = await post(`${base}/r`, { a: 1 }, 'http://ex/alice');
    expect(res.status).toBe(500);
    for (const layer of ['use', 'router', 'error']) {
      expect(seen[layer]?.kind).toBe('http');
      expect(seen[layer]?.request).toBe(seen.req);
    }
    expect(seen.use).toBe(seen.router);
    expect(seen.router).toBe(seen.error);
  });

  it('an assigned this.request lasts for that call only', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    class Pinning extends BackendProvider {
      @callable('public')
      async pin() {
        this.request = { linkedAuth: { userAccount: { id: 'http://ex/admin' } } };
        await tick(5);
        return this.request.linkedAuth.userAccount.id;
      }
      @callable('public')
      who() {
        return this.request?.linkedAuth?.userAccount?.id ?? null;
      }
    }
    const server = makeLinkedServer();
    server.genericProviders.set('pin', new Pinning({}, server));
    const base = await listen(server);
    expect((await call(base, 'pin', 'pin', [])).json).toBe('http://ex/admin');
    expect((await call(base, 'pin', 'who', [])).json).toBe(null);
    expect((await call(base, 'pin', 'who', [], 'http://ex/bob')).json).toBe('http://ex/bob');
    // outside any call the assignment is ignored
    const p: any = server.genericProviders.get('pin');
    p.request = { pinned: true };
    expect(p.request).toBeUndefined();
    expect(runWithCallContext({ kind: 'http', request: { r: 1 }, response: {} }, () => p.request)).toEqual({ r: 1 });
  });
});

describe('override of a user method', () => {
  it('answers 401 without a session in warn mode', async () => {
    class Override extends TestProvider {
      whoami() {
        return 'override';
      }
    }
    const server = makeLinkedServer();
    server.genericProviders.set('ovr', new Override({}, server));
    const base = await listen(server);
    expect((await call(base, 'ovr', 'whoami', [])).status).toBe(401);
    expect((await call(base, 'ovr', 'whoami', [], ME)).json).toBe('override');
    expect(undeclaredWarnings()).toHaveLength(0);
  });
});

describe('uploads', () => {
  it('are served with nosniff and a sandbox CSP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
    fs.writeFileSync(path.join(dir, 'evil.html'), '<script>alert(1)</script>');
    fs.writeFileSync(path.join(dir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const app = express();
    mountUploads(app, dir);
    const s = await new Promise<any>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    servers.push(s);
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    for (const file of ['evil.html', 'photo.png']) {
      const res = await fetch(`${base}/uploads/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe('sandbox');
      await res.arrayBuffer();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('log lines', () => {
  it('escape control characters in client-supplied names', () => {
    expect(logSafe('a\nb\r\u001b[31m')).toBe('a\\u000ab\\u000d\\u001b[31m');
    expect(logSafe('x'.repeat(500)).length).toBeLessThanOrEqual(121);
  });

  it('a refused method name cannot forge a log line', async () => {
    const base = await listen(makeLinkedServer());
    await call(base, 'pkg', encodeURIComponent('nope\n[linked] forged'), []);
    const lines = warn.mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some((l: string) => l.includes('nope\\u000a[linked] forged'))).toBe(true);
    expect(lines.some((l: string) => l.includes('\n[linked] forged'))).toBe(false);
  });
});
