import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { LincdServerProxy } from '@_linked/server-utils/utils/LincdServerProxy';
import { Server } from '@_linked/server-utils/utils/Server';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { LinkedServer } from '../shapes/LinkedServer.js';
import { LincdAPI } from '../shapes/LincdAPI.js';
import { LincdAPI } from '../shapes/LincdAPI.js';
import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';

// These suites exercise LinkedServer's SHAPE-provider routing and error handling,
// so they need any registered Shape plus a ShapeProvider for it. They used to borrow
// BackendAPIStore + BackendAPIStoreProvider; BackendAPIStore is no longer a Shape
// (it addresses the backend by package name now), so LincdAPI stands in.
import { getShapeIndex, indexShapesIntoMemory } from '../utils/Shapes.js';

// Error semantics of server calls:
// - a call no provider handles answers 501 `{error: "No provider for <pkg>/<method>"}`
// - BackendAPIStore rejects only on a failed call, and resolves `undefined` results

const servers: any[] = [];
const originalCall = Server.call;

afterEach(async () => {
  (Server as any).call = originalCall;
  jest.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

function makeLinkedServer(): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.genericProviders = new Map();
  server.shapeProviders = new Map();
  server.initRequest = async () => {};
  return server;
}

async function listen(app: any): Promise<string> {
  const s = await new Promise<any>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function listenCalls(linkedServer: any): Promise<string> {
  const app = express();
  app.use(express.json());
  // Mirrors LinkedServer's routes, including the `@scope/pkg` variants that
  // LincdServerProxy uses for scoped package names like `@_linked/server`.
  app.post(
    '/call/@:scope/:pkg/:method',
    linkedServer.handleErrorsJson((req, res) => {
      req.params.pkg = `@${req.params.scope}/${req.params.pkg}`;
      return linkedServer.processBackendMethodCall(req, res);
    })
  );
  app.post(
    '/call/@:scope/:pkg/:shape/:method',
    linkedServer.handleErrorsJson((req, res) => {
      req.params.pkg = `@${req.params.scope}/${req.params.pkg}`;
      return linkedServer.processShapeMethodCall(req, res);
    })
  );
  app.post(
    '/call/:pkg/:method',
    linkedServer.handleErrorsJson((req, res) =>
      linkedServer.processBackendMethodCall(req, res)
    )
  );
  app.post(
    '/call/:pkg/:shape/:method',
    linkedServer.handleErrorsJson((req, res) =>
      linkedServer.processShapeMethodCall(req, res)
    )
  );
  return listen(app);
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

function storeProvider(overrides: Record<string, any>) {
  const provider: any = Object.create(ShapeProvider.prototype);
  provider.shape = LincdAPI;
  provider.initRequest = () => {};
  return Object.assign(provider, overrides);
}

const storeShapeCall = (base: string, method: string) =>
  post(`${base}/call/server/LincdAPI/${method}`, {
    shapeURI: (LincdAPI as any).shape.id,
    instanceNode: null,
    args: [{}],
  });

describe('LinkedServer unmatched calls', () => {
  it('answers a shape method call without a matching provider with 501', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.shapeProviders.set('server', []);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await listenCalls(linkedServer);

    const res = await storeShapeCall(base, 'selectQuery');

    expect(res.status).toBe(501);
    expect(res.json).toEqual({ error: 'No provider for server/selectQuery' });
  });

  it('answers 501 when the shape provider lacks the method', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.shapeProviders.set('server', [storeProvider({})]);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await listenCalls(linkedServer);

    const res = await storeShapeCall(base, 'noSuchMethod');

    expect(res.status).toBe(501);
    expect(res.json).toEqual({ error: 'No provider for server/noSuchMethod' });
  });

  it('answers a backend method call for a package without a provider with 501', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.genericProviders.set('pkg', null);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await listenCalls(linkedServer);

    const res = await post(`${base}/call/pkg/anything`, { args: [] });

    expect(res.status).toBe(501);
    expect(res.json).toEqual({ error: 'No provider for pkg/anything' });
  });

  it('answers 501 when the generic provider lacks the method', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.genericProviders.set('pkg', { initRequest: () => {} });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await listenCalls(linkedServer);

    const res = await post(`${base}/call/pkg/missing`, { args: [] });

    expect(res.status).toBe(501);
    expect(res.json).toEqual({ error: 'No provider for pkg/missing' });
  });

  it('rejects a direct (backend-to-backend) unmatched call with a 501 ServerCallError', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.genericProviders.set('pkg', null);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const err: any = await linkedServer
      .callBackendMethod('pkg', 'missing', [])
      .catch((e: any) => e);

    expect(ServerCallError.is(err)).toBe(true);
    expect(err.status).toBe(501);
    expect(err.message).toBe('No provider for pkg/missing');
  });
});

describe('BackendAPIStore call results', () => {
  const storePkg: string = (BackendAPIStore as any).packageName;

  // Route Server.call through a real proxy to a real express app, so the store,
  // the proxy and the LinkedServer routes are exercised together.
  function routeServerCallTo(base: string) {
    const proxy = new LincdServerProxy(base);
    (Server as any).call = (...args: any[]) => (proxy.call as any)(...args);
  }

  it('opts in to rejectOnError', async () => {
    const calls: any[] = [];
    (Server as any).call = async (...args: any[]) => {
      calls.push(args);
      return null;
    };
    const store = new BackendAPIStore({ id: 'http://example.org/store' });
    await store.selectQuery({ toJSON: () => ({}) } as any);
    expect(calls[0][1]).toEqual({ method: 'selectQuery', rejectOnError: true });
  });

  it('resolves an undefined result', async () => {
    (Server as any).call = async () => undefined;
    const store = new BackendAPIStore({ id: 'http://example.org/store' });

    await expect(
      store.updateQuery({ toJSON: () => ({}) } as any)
    ).resolves.toBeUndefined();
  });

  it('rejects with the server message and status when the provider fails (500)', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.shapeProviders.set(storePkg, [
      storeProvider({
        selectQuery: async () => {
          throw new Error('Cannot resolve an rdf:type for shape');
        },
      }),
    ]);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await listenCalls(linkedServer);
    routeServerCallTo(base);
    const store = new BackendAPIStore({ id: 'http://example.org/store' });

    const err: any = await store
      .selectQuery({ toJSON: () => ({}) } as any)
      .catch((e: any) => e);

    expect(ServerCallError.is(err)).toBe(true);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/^internal server error/);
  });

  it('rejects with the 501 message when no provider handles the call', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.shapeProviders.set(storePkg, []);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await listenCalls(linkedServer);
    routeServerCallTo(base);
    const store = new BackendAPIStore({ id: 'http://example.org/store' });

    await expect(
      store.askQuery({ toJSON: () => ({}) } as any)
    ).rejects.toMatchObject({
      status: 501,
      message: `No provider for ${storePkg}/askQuery`,
    });
  });
});

describe('Missing ./backend export', () => {
  function linkedServerWithVite(loadError: Error): any {
    const server: any = makeLinkedServer();
    server.package = { name: 'app' };
    server.config = {
      server: {
        vite: {
          pluginContainer: { resolveId: async (id: string) => id },
          ssrLoadModule: async () => {
            throw loadError;
          },
        },
      },
    };
    return server;
  }
  const notExported = () =>
    new Error('Missing "./backend" specifier in "some-pkg" package');

  it('is silent for a package without a ./backend export', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const server = linkedServerWithVite(notExported());

    await server.indexPackageBackendProviders('some-pkg', false);

    expect(warn).not.toHaveBeenCalled();
    expect(server.genericProviders.get('some-pkg')).toBeNull();
  });

  it('only gives the "could not find" hint when asked to warn', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const server = linkedServerWithVite(notExported());

    await server.indexPackageBackendProviders('some-pkg', true);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /Could not find backend file of package some-pkg/
    );
  });

  it('stays loud for a real load error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const server = linkedServerWithVite(new SyntaxError('Unexpected token'));

    await server.indexPackageBackendProviders('some-pkg', false);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Could not load backend file/);
  });
});

describe('LincdAPI.get_all_shapes', () => {
  function useDataset(rawQuery: () => Promise<any>) {
    LinkedStorage.setDefaultDataset({
      init: async () => {},
      selectQuery: async () => [],
      createQuery: async () => ({}),
      updateQuery: async () => ({}),
      deleteQuery: async () => ({}),
      askQuery: async () => false,
      rawQuery,
    } as any);
  }

  async function aShapeWithTargetClass(): Promise<[string, any]> {
    await indexShapesIntoMemory();
    const entry = Object.entries(getShapeIndex()).find(
      ([, shape]: [string, any]) => shape.targetClass?.id
    );
    if (!entry) throw new Error('expected at least one indexed shape');
    return entry as [string, any];
  }

  it('counts instances from a SELECT result', async () => {
    const [shapeId, shape] = await aShapeWithTargetClass();
    useDataset(async () => ({
      head: { vars: ['count', 'type'] },
      results: {
        bindings: [
          {
            count: { type: 'literal', value: '7' },
            type: { type: 'uri', value: shape.targetClass.id },
          },
        ],
      },
    }));

    const result = await new LincdAPI().get_all_shapes();

    expect(result.shapes[shapeId].numInstances).toBe(7);
  });

  it('ignores an ASK (boolean) result instead of reading bindings from it', async () => {
    const [shapeId] = await aShapeWithTargetClass();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    useDataset(async () => ({ head: {}, boolean: true }));

    const result = await new LincdAPI().get_all_shapes();

    expect(error).not.toHaveBeenCalled();
    expect(result.shapes[shapeId].numInstances).toBe(0);
  });
});
