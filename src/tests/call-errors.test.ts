import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';
import { Server } from '@_linked/server-utils/utils/Server';
import { LinkedServer } from '../shapes/LinkedServer.js';
import { BackendAPIStore } from '../shapes/quadstores/BackendAPIStore.js';
import { LincdAPI } from '../shapes/LincdAPI.js';
import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';

// These suites exercise LinkedServer's SHAPE-provider routing and error handling,
// so they need any registered Shape plus a ShapeProvider for it. They used to borrow
// BackendAPIStore + BackendAPIStoreProvider; BackendAPIStore is no longer a Shape
// (it addresses the backend by package name now), so LincdAPI stands in.

// A provider method that throws must answer with an error status and a JSON
// `{error}` body (the same shape `handleErrorsJson`/`sendError` use elsewhere),
// never `200 null`. The client store must surface a failed call as a rejection.
// Unmatched calls (501) and the store's resolution rules: call-semantics.test.ts.

const servers: any[] = [];
const originalCall = Server.call;

afterEach(async () => {
  (Server as any).call = originalCall;
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

async function listen(linkedServer: any): Promise<string> {
  const app = express();
  app.use(express.json());
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
  const s = await new Promise<any>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
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

describe('LinkedServer call errors', () => {
  it('answers a throwing shape provider method with 500 and a JSON error', async () => {
    const linkedServer = makeLinkedServer();
    let called = false;
    const provider: any = Object.create(ShapeProvider.prototype);
    provider.shape = LincdAPI;
    provider.initRequest = () => {};
    provider.selectQuery = async () => {
      called = true;
      throw new Error('Cannot resolve an rdf:type for shape');
    };
    // Keyed by the `:pkg` route segment, so the provider is found without indexing.
    linkedServer.shapeProviders.set('server', [provider]);
    const base = await listen(linkedServer);

    const res = await post(`${base}/call/server/LincdAPI/selectQuery`, {
      shapeURI: (LincdAPI as any).shape.id,
      instanceNode: null,
      args: [{}],
    });

    expect(called).toBe(true);
    expect(res.status).toBe(500);
    expect(typeof res.json.error).toBe('string');
  });

  it('answers a throwing generic backend provider method with 500 and a JSON error', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.genericProviders.set('pkg', {
      initRequest: () => {},
      explode: async () => {
        throw new Error('boom');
      },
    });
    const base = await listen(linkedServer);

    const res = await post(`${base}/call/pkg/explode`, { args: [] });

    expect(res.status).toBe(500);
    expect(typeof res.json.error).toBe('string');
  });

  it('still answers a successful call with 200 and its JSON result', async () => {
    const linkedServer = makeLinkedServer();
    linkedServer.genericProviders.set('pkg', {
      initRequest: () => {},
      ok: async () => ({ value: 1 }),
    });
    const base = await listen(linkedServer);

    const res = await post(`${base}/call/pkg/ok`, { args: [] });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ value: 1 });
  });
});

describe('BackendAPIStore failed calls', () => {
  it('rejects when Server.call rejects (a non-2xx response with rejectOnError)', async () => {
    (Server as any).call = async () => {
      throw new Error('internal server error');
    };
    const store = new BackendAPIStore({ id: 'http://example.org/store' });
    const query: any = { toJSON: () => ({}) };

    await expect(store.selectQuery(query)).rejects.toThrow(
      /internal server error/
    );
  });

  it('resolves a null result from a successful call', async () => {
    (Server as any).call = async () => null;
    const store = new BackendAPIStore({ id: 'http://example.org/store' });
    const query: any = { toJSON: () => ({}) };

    await expect(store.deleteQuery(query)).resolves.toBeNull();
  });
});
