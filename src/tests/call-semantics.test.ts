import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { LincdServerProxy } from '@_linked/server-utils/utils/LincdServerProxy';
import { Server } from '@_linked/server-utils/utils/Server';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { LinkedServer, registerCallRoutes } from '../shapes/LinkedServer.js';
import { LincdAPI } from '../shapes/LincdAPI.js';
import { BackendAPIStore } from '../shapes/quadstores/BackendAPIStore.js';
import { packageName } from '../package.js';
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
  // The real routes, exactly as LinkedServer.start() registers them.
  registerCallRoutes(app, linkedServer);
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
  // The store addresses the backend by PACKAGE now, so the expected name comes
  // from the package module -- the same source the store itself uses. It used to
  // read `BackendAPIStore.packageName`, a static that existed only while the
  // store was a Shape, which silently read `undefined` once it stopped being one.
  const storePkg: string = packageName;

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
    // The GENERIC registry, not `shapeProviders`: the store addresses the
    // backend by package now, and the package form of a call is served from
    // `genericProviders`. Priming the shape registry left the package form
    // with nothing to miss on, so it failed further in as a 500.
    linkedServer.genericProviders.set(storePkg, null);
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
  // A real package directory: whether there is a backend is decided from the
  // package's exports and the file system, before anything is imported.
  let appDir: string;
  let originalCwd: string;
  beforeEach(() => {
    originalCwd = process.cwd();
    appDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-missing-backend-')));
    process.chdir(appDir);
  });
  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(appDir, { recursive: true, force: true });
  });

  function installSomePkg(withBackend: boolean) {
    const root = path.join(appDir, 'node_modules', 'some-pkg');
    fs.mkdirSync(path.join(root, 'lib', 'esm'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'some-pkg',
        type: 'module',
        exports: { '.': './lib/esm/index.js', './*': './lib/esm/*.js' },
      })
    );
    if (withBackend) fs.writeFileSync(path.join(root, 'lib', 'esm', 'backend.js'), '');
  }

  function linkedServerWithVite(loadError: Error): any {
    const server: any = makeLinkedServer();
    server.package = { name: 'app' };
    server.config = {
      server: {
        vite: {
          // Bundled by the SSR runner, so its backend is loaded through Vite
          // (an external package would go to Node's import instead).
          config: { ssr: { noExternal: ['some-pkg'] } },
          ssrLoadModule: jest.fn(async () => {
            throw loadError;
          }),
        },
      },
    };
    return server;
  }

  it('is silent, and loads nothing, for a package without a ./backend entry', async () => {
    installSomePkg(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const server = linkedServerWithVite(new Error('must not be loaded'));

    await server.indexPackageBackendProviders('some-pkg', false);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(server.config.server.vite.ssrLoadModule).not.toHaveBeenCalled();
    expect(server.genericProviders.get('some-pkg')).toBeNull();
  });

  it('only gives the "could not find" hint when asked to warn', async () => {
    installSomePkg(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const server = linkedServerWithVite(new Error('must not be loaded'));

    await server.indexPackageBackendProviders('some-pkg', true);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      /Could not find backend file of package some-pkg/
    );
  });

  it('stays loud, naming the package, for a real load error', async () => {
    installSomePkg(true);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const server = linkedServerWithVite(new SyntaxError('Unexpected token'));

    await server.indexPackageBackendProviders('some-pkg', false);

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(
      /\[linked\] some-pkg backend .*backend\.js failed: Unexpected token/
    );
    expect(server.genericProviders.get('some-pkg')).toBeNull();
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
