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

// HTTP behaviour of the RPC exposure rules, driven through the real routes
// (registerCallRoutes) and the real JSON body parser.

const { linkedShape } = linkedPackage('rpc-exposure-test');
const NS = 'http://example.org/rpc-test/';

@linkedShape({ name: 'RpcSecret' })
class RpcSecret extends Shape {
  static targetClass = { id: NS + 'Secret' };
  @literalProperty({ path: { id: NS + 'token' }, maxCount: 1 })
  get token(): string {
    return '';
  }
}

@linkedShape({ name: 'RpcPerson' })
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

describe('resolveCallable', () => {
  const provider = new TestProvider({}, {});

  it('resolves declarations on the provider class', () => {
    expect(resolveCallable(provider, 'ping')).toMatchObject({ status: 'callable', level: 'public', owner: TestProvider });
    expect(resolveCallable(provider, 'whoami')).toMatchObject({ status: 'callable', level: 'user' });
    expect(resolveCallable(provider, 'undeclared')).toMatchObject({ status: 'undeclared', owner: TestProvider });
    expect(resolveCallable(provider, 'nope')).toEqual({ status: 'missing' });
  });

  it('reserves base-class methods, Object.prototype, accessors and fields', () => {
    for (const name of [
      'initRequest',
      'registerRoute',
      'disposeRoutes',
      'assignEnvPathToField',
      'callOtherProvider',
      'setupBeforeControllers',
      'setupAfterControllers', // overridden by TestProvider: still reserved
      'dispose', // a server lifecycle hook, defined only by the subclass
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'request',
      'response',
      'server',
      'lincdServer',
    ]) {
      expect([name, resolveCallable(provider, name).status]).toEqual([name, 'reserved']);
    }
  });

  it('resolves internal declarations, also over a callable one and into overrides', () => {
    expect(resolveCallable(provider, 'secret')).toEqual({ status: 'internal', owner: TestProvider });
    expect(resolveCallable(provider, 'bothWays').status).toBe('internal');
    class Sub extends TestProvider {
      @callable('public')
      secret() {
        return 'sub';
      }
    }
    expect(resolveCallable(new Sub({}, {}), 'secret').status).toBe('internal');
  });

  it('an undeclared override keeps the strictest level declared up its chain', () => {
    class Sub extends TestProvider {
      ping() {
        return 'sub';
      }
      whoami() {
        return 'sub';
      }
      fresh() {
        return 'new';
      }
    }
    const sub = new Sub({}, {});
    expect(resolveCallable(sub, 'ping')).toMatchObject({ status: 'callable', level: 'public', inherited: true });
    expect(resolveCallable(sub, 'whoami')).toMatchObject({ status: 'callable', level: 'user', inherited: true });
    expect(resolveCallable(sub, 'fresh').status).toBe('undeclared');

    // an explicit declaration on the override is the class's own choice...
    class Relaxed extends TestProvider {
      @callable('public')
      whoami() {
        return 'relaxed';
      }
    }
    expect(resolveCallable(new Relaxed({}, {}), 'whoami')).toMatchObject({ status: 'callable', level: 'public' });
    // ...but an undeclared override below it takes the strictest of the chain
    class Below extends Relaxed {
      whoami() {
        return 'below';
      }
    }
    expect(resolveCallable(new Below({}, {}), 'whoami')).toMatchObject({ status: 'callable', level: 'user' });
  });

  it('a method assigned onto the instance keeps the level its class declares', () => {
    const p: any = new TestProvider({}, {});
    p.whoami = () => 'assigned';
    expect(resolveCallable(p, 'whoami')).toMatchObject({ status: 'callable', level: 'user', inherited: true });
  });
});

describe('RPC exposure over HTTP', () => {
  it.each(['initRequest', 'setupAfterControllers', 'toString', 'constructor', 'registerRoute', 'hasOwnProperty', 'dispose'])(
    'answers 501 for reserved %s on the generic route',
    async (method) => {
      disposed = 0;
      const base = await listen(makeLinkedServer());
      const res = await call(base, 'pkg', method, [{ linkedAuth: { userAccount: 'forged' } }]);
      expect(res.status).toBe(501);
      expect(res.json).toEqual({ error: `No provider for pkg/${method}` });
      expect(disposed).toBe(0);
    }
  );

  it.each(['initRequest', 'setupAfterControllers', 'toString'])(
    'answers 501 for reserved %s on the shape route',
    async (method) => {
      const base = await listen(makeLinkedServer());
      const res = await shapeCall(base, method);
      expect(res.status).toBe(501);
    }
  );

  it('dispatches a declared method on the shape route', async () => {
    const base = await listen(makeLinkedServer());
    const res = await shapeCall(base, 'ping');
    expect(res).toMatchObject({ status: 200, json: 'shape-pong' });
  });

  it('runs an undeclared method in warn mode, warning once', async () => {
    const base = await listen(makeLinkedServer());
    expect(await call(base, 'pkg', 'undeclared')).toMatchObject({ status: 200, json: 'ran' });
    expect(await call(base, 'pkg', 'undeclared', [], 'http://ex/u1')).toMatchObject({ status: 200 });
    expect(undeclaredWarnings()).toHaveLength(1);
    expect(String(undeclaredWarnings()[0][0])).toMatch(/pkg TestProvider\.undeclared \(session: no\)/);
  });

  it('refuses an undeclared method in enforce mode (501)', async () => {
    setRpcExposureMode('enforce');
    const base = await listen(makeLinkedServer());
    expect((await call(base, 'pkg', 'undeclared')).status).toBe(501);
    expect((await call(base, 'pkg', 'ping')).status).toBe(200);
  });

  it('reads the mode from LINKED_RPC_EXPOSURE', async () => {
    process.env.LINKED_RPC_EXPOSURE = 'enforce';
    try {
      const base = await listen(makeLinkedServer());
      expect((await call(base, 'pkg', 'undeclared')).status).toBe(501);
    } finally {
      delete process.env.LINKED_RPC_EXPOSURE;
    }
  });

  it("answers 401 for a 'user' method without a session, and runs it with one", async () => {
    const base = await listen(makeLinkedServer());
    expect((await call(base, 'pkg', 'whoami')).status).toBe(401);
    expect(await call(base, 'pkg', 'whoami', [], 'http://ex/alice')).toMatchObject({
      status: 200,
      json: 'http://ex/alice',
    });
  });

  it('answers 501 on the generic route for a provider with static rpc = false', async () => {
    const base = await listen(makeLinkedServer());
    expect((await call(base, 'norpc', 'ping')).status).toBe(501);
  });

  it('gives two interleaved calls each their own linkedAuth', async () => {
    const base = await listen(makeLinkedServer());
    const [a, b] = await Promise.all([
      call(base, 'pkg', 'slowWhoami', [40], 'http://ex/alice'),
      call(base, 'pkg', 'slowWhoami', [0], 'http://ex/bob'),
    ]);
    expect(a.json).toBe('http://ex/alice');
    expect(b.json).toBe('http://ex/bob');
  });

  it('a forged initRequest call cannot plant a session', async () => {
    const server = makeLinkedServer();
    const base = await listen(server);
    await call(base, 'pkg', 'initRequest', [{ linkedAuth: { userAccount: { id: 'evil' } } }, {}]);
    expect((await call(base, 'pkg', 'whoami')).status).toBe(401);
    expect(server.genericProviders.get('pkg').request).toBeUndefined();
  });
});

describe('internal methods', () => {
  const internalRefusals = () =>
    warn.mock.calls.filter((c: any[]) => String(c[0]).includes('refused call to internal method'));

  it.each(['warn', 'enforce'] as const)('answer 501 on both routes in %s mode', async (mode) => {
    setRpcExposureMode(mode);
    const base = await listen(makeLinkedServer());
    for (const user of [undefined, 'http://ex/alice']) {
      expect(await call(base, 'pkg', 'secret', [], user)).toMatchObject({
        status: 501,
        json: { error: 'No provider for pkg/secret' },
      });
      expect((await call(base, 'pkg', 'bothWays', [], user)).status).toBe(501);
    }
    expect((await shapeCall(base, 'shapeSecret')).status).toBe(501);
    expect((await shapeCall(base, 'ping')).status).toBe(200);
    expect(undeclaredWarnings()).toHaveLength(0);
    expect(internalRefusals().length).toBeGreaterThan(0);
  });

  it('still run for backend-to-backend calls, outside and inside a request', async () => {
    setRpcExposureMode('enforce');
    const server = makeLinkedServer();
    await expect(server.callBackendMethod('pkg', 'secret', [])).resolves.toBe('secret');
    const base = await listen(server);
    expect(await call(base, 'pkg', 'nestedSecret', [], 'http://ex/carol')).toMatchObject({
      status: 200,
      json: 'secret',
    });
  });

  it('can be declared from outside on an imported provider class', async () => {
    const key = Symbol.for('@_linked/server-utils:internal');
    const base = await listen(makeLinkedServer());
    const before = await call(base, '@_linked/server', 'getShapes');
    expect(before.status).not.toBe(501);
    declareInternal(LincdServerBackendProvider, ['getShapes', 'selectQuery']);
    try {
      expect((await call(base, '@_linked/server', 'getShapes')).status).toBe(501);
      // wins over the class's own @callable('public'), with a warning
      expect((await call(base, '@_linked/server', 'selectQuery', [{}])).status).toBe(501);
      expect(
        warn.mock.calls.some((c: any[]) => /selectQuery is declared both callable and internal/.test(String(c[0])))
      ).toBe(true);
    } finally {
      delete (LincdServerBackendProvider as any)[key];
    }
    expect((await call(base, '@_linked/server', 'getShapes')).status).not.toBe(501);
  });
});

describe('backend-to-backend calls', () => {
  it('run as system outside a request', async () => {
    const server = makeLinkedServer();
    await expect(server.callBackendMethod('pkg', 'contextKind', [])).resolves.toEqual({
      kind: 'system',
      user: undefined,
    });
  });

  it('inherit the request they are made in', async () => {
    const base = await listen(makeLinkedServer());
    const res = await call(base, 'pkg', 'nested', [], 'http://ex/carol');
    expect(res.json).toEqual({ kind: 'http', user: 'http://ex/carol' });
  });

  it('skip the declaration rules, but not the reserved names', async () => {
    setRpcExposureMode('enforce');
    const server = makeLinkedServer();
    await expect(server.callBackendMethod('pkg', 'undeclared', [])).resolves.toBe('ran');
    await expect(server.callBackendMethod('norpc', 'ping', [])).resolves.toBe('pong');
    const err: any = await server.callBackendMethod('pkg', 'initRequest', [{}, {}]).catch((e: any) => e);
    expect(ServerCallError.is(err)).toBe(true);
    expect(err.status).toBe(501);
  });
});

describe('RPC argument revival', () => {
  it('logs a Shape class argument in warn mode, refuses it (400) in enforce', async () => {
    const base = await listen(makeLinkedServer());
    const arg = { value: { __sc: (RpcPerson as any).shape.id } };
    const res = await call(base, 'pkg', 'echo', [arg]);
    expect(res).toMatchObject({ status: 200, json: { type: 'function' } });
    expect(warn.mock.calls.some((c: any[]) => String(c[0]).includes('revives the Shape class'))).toBe(true);

    setRpcExposureMode('enforce');
    expect((await call(base, 'pkg', 'echo', [arg])).status).toBe(400);
  });

  it('drops __proto__ keys from arguments', async () => {
    const base = await listen(makeLinkedServer());
    const res = await post(
      `${base}/call/pkg/echo`,
      '{"args":[{"value":1,"__proto__":{"isAdmin":true}}]}'
    );
    expect(res).toMatchObject({
      status: 200,
      json: { type: 'number', prototypeIsObject: true, isAdmin: false },
    });
  });
});

describe('generic query plane', () => {
  const received: any[] = [];
  beforeEach(() => {
    received.length = 0;
    LinkedStorage.setDefaultDataset({
      init: async () => {},
      selectQuery: async (q: any) => (received.push(q), []),
      createQuery: async (q: any) => (received.push(q), {}),
      updateQuery: async (q: any) => (received.push(q), {}),
      deleteQuery: async (q: any) => (received.push(q), {}),
      askQuery: async (q: any) => (received.push(q), false),
      rawQuery: async () => ({ head: {}, results: { bindings: [] } }),
    } as any);
  });

  const Person = RpcPerson as any;
  const nested = () => Person.select((p: any) => [p.name, p.secret.token]).toJSON();
  const cast = () => Person.select((p: any) => p.friends.as(RpcSecret).token).toJSON();
  const plain = () => Person.select((p: any) => p.name).toJSON();
  const direct = () => (RpcSecret as any).select((s: any) => s.token).toJSON();

  it('lets a signed-in user query unprotected shapes', async () => {
    const base = await listen(makeLinkedServer());
    const res = await call(base, '@_linked/server', 'selectQuery', [plain()], 'http://ex/u');
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('warns about, but still answers, an anonymous query in warn mode; 401 in enforce', async () => {
    const base = await listen(makeLinkedServer());
    expect((await call(base, '@_linked/server', 'selectQuery', [plain()])).status).toBe(200);
    expect(warn.mock.calls.some((c: any[]) => String(c[0]).includes('anonymous selectQuery'))).toBe(true);
    setRpcExposureMode('enforce');
    expect((await call(base, '@_linked/server', 'selectQuery', [plain()])).status).toBe(401);
  });

  it.each([
    ['a direct select', direct],
    ['a nested traversal', nested],
    ['a cast', cast],
  ])('answers 403 for %s of a protected shape', async (_label, query) => {
    registerProtectedShapes([RpcSecret], { deny: 'all', owner: 'rpc-test' });
    const base = await listen(makeLinkedServer());
    const res = await call(base, '@_linked/server', 'selectQuery', [query()], 'http://ex/u');
    expect(res.status).toBe(403);
    // and anonymously, in warn mode
    expect((await call(base, '@_linked/server', 'selectQuery', [query()])).status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("answers 403 for a write to a deny:'write' shape, but allows reading it", async () => {
    registerProtectedShapes([RpcPerson], { deny: 'write', owner: 'rpc-test' });
    const base = await listen(makeLinkedServer());
    const del = Person.delete('http://ex/p1').toJSON();
    const upd = Person.update({ name: 'x' }).for('http://ex/p1').toJSON();
    expect((await call(base, '@_linked/server', 'deleteQuery', [del], 'http://ex/u')).status).toBe(403);
    expect((await call(base, '@_linked/server', 'updateQuery', [upd], 'http://ex/u')).status).toBe(403);
    expect((await call(base, '@_linked/server', 'selectQuery', [plain()], 'http://ex/u')).status).toBe(200);
  });

  it('applies the same rules on the /api routes', async () => {
    registerProtectedShapes([RpcSecret], { deny: 'all', owner: 'rpc-test' });
    const base = await listen(makeLinkedServer());
    const ok = await post(`${base}/api/select`, { query: plain() }, 'http://ex/u');
    expect(ok.status).toBe(200);
    const refused = await post(`${base}/api/select`, { query: nested() }, 'http://ex/u');
    expect(refused.status).toBe(403);
  });

  it('refuses anonymous raw SPARQL in every mode', async () => {
    const base = await listen(makeLinkedServer());
    const q = { query: 'SELECT * WHERE { ?s ?p ?o }' };
    expect((await post(`${base}/api/select-raw`, q)).status).toBe(401);
    setRpcExposureMode('enforce');
    expect((await post(`${base}/api/select-raw`, q)).status).toBe(401);
  });

  it('runs local queries outside a request without checks', async () => {
    registerProtectedShapes([RpcSecret], { deny: 'all', owner: 'rpc-test' });
    const server = makeLinkedServer();
    await expect(server.callBackendMethod('@_linked/server', 'selectQuery', [direct()])).resolves.toEqual([]);
  });
});

describe('server-side rendering', () => {
  it('runs the render path inside an http call context for that request', async () => {
    const server = makeLinkedServer();
    const seen: any[] = [];
    // stands in for the page render; render() itself is the real entry point
    server.renderPage = async (req: any) => {
      await tick(req.delay);
      const ctx = getCallContext() as any;
      seen.push({ kind: ctx?.kind, sameRequest: ctx?.request === req, user: ctx?.request?.linkedAuth?.userAccount?.id });
      // a Server.call made while rendering inherits the request, not system
      return server.callBackendMethod('pkg', 'contextKind', []);
    };
    const req = (user: string, delay: number) => ({ delay, linkedAuth: { userAccount: { id: user } } });
    const [a, b] = await Promise.all([
      server.render(req('http://ex/alice', 30), {}),
      server.render(req('http://ex/bob', 0), {}),
    ]);
    expect(a).toEqual({ kind: 'http', user: 'http://ex/alice' });
    expect(b).toEqual({ kind: 'http', user: 'http://ex/bob' });
    expect(seen).toEqual([
      { kind: 'http', sameRequest: true, user: 'http://ex/bob' },
      { kind: 'http', sameRequest: true, user: 'http://ex/alice' },
    ]);
    expect(getCallContext()).toBeUndefined();
  });
});

describe('@_linked/server default provider', () => {
  it('keeps getShapes internal: no client calls it, /api/all-shapes serves the index', () => {
    const provider = new LincdServerBackendProvider({}, makeLinkedServer());
    expect(resolveCallable(provider, 'getShapes').status).toBe('undeclared');
    for (const m of ['selectQuery', 'askQuery', 'createQuery', 'updateQuery', 'deleteQuery']) {
      expect(resolveCallable(provider, m)).toMatchObject({ status: 'callable', level: 'public' });
    }
  });
});
