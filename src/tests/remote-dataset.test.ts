import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';
import { SelectBuilder } from '@_linked/core/queries/QueryBuilder';
import { AskBuilder } from '@_linked/core/queries/AskBuilder';
import { NodeShape } from '@_linked/core/shapes/SHACL';

// The url form of RemoteDataset is a thin HTTP client: every query goes out as
// `{args: [toJSON()]}` to `{url}/call/@_linked/server/<method>` with the bearer token, and
// the body comes back untouched. These tests pin the wire and the error mapping with a
// stubbed `globalThis.fetch`; the last suite answers `ping` through the real call routes.

// `Server` only builds its proxy (and so can take a local server) when SITE_ROOT is set at
// import time, so the modules are imported after it is.
process.env.SITE_ROOT ??= 'http://app.test:4000';
const { Server } = await import('@_linked/server-utils/utils/Server');
const {
  RemoteDataset,
  RemoteDatasetError,
  RemoteDatasetUnauthorizedError,
  RemoteDatasetUnreachableError,
  USER_TOKEN_HEADER,
  USER_TOKEN_HEADERS_HOOK,
} = await import('../shapes/quadstores/RemoteDataset.js');
const { runWithCallContext, runAsSystem } = await import('@_linked/server-utils/utils/CallContext');
const { LinkedServer, registerCallRoutes } = await import('../shapes/LinkedServer.js');
const { default: LincdServerBackendProvider } = await import('../backend.js');
const { packageName } = await import('../package.js');

const URL_BASE = 'http://cn.test:4040/gateway';
const TOKEN = 'b'.repeat(64);
const IRI = 'http://example.org/shape-1';

type Call = { url: string; init: RequestInit };

// The store reads nothing from a query but `toJSON()`. The mutation builders and the count
// envelope refuse to serialize without a registered shape, which no test here boots, so those
// use a stand-in that returns the DSL-JSON a real builder would.
function queryJson(json: Record<string, unknown>) {
  return { toJSON: () => json } as any;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/html' } });
}

const originalFetch = globalThis.fetch;
const originalCall = Server.call;

function stubFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return answer(call);
  };
  return calls;
}

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  (Server as any).call = originalCall;
  jest.restoreAllMocks();
});

function store(config: Record<string, unknown> = {}) {
  return new RemoteDataset({ url: URL_BASE, token: TOKEN, ...config });
}

function sentBody(call: Call): any {
  return JSON.parse(String(call.init.body));
}

function expectWire(call: Call, method: string, args: unknown[]) {
  expect(call.url).toBe(`${URL_BASE}/call/@_linked/server/${method}`);
  expect(call.init.method).toBe('POST');
  const headers = call.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(headers['Content-Type']).toBe('application/json');
  expect(headers.Accept).toBe('application/json');
  expect(Object.keys(headers).sort()).toEqual(['Accept', 'Authorization', 'Content-Type']);
  expect(sentBody(call)).toEqual({ args });
}

async function caught(promise: Promise<unknown>): Promise<any> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e) => e,
  );
}

describe('RemoteDataset config', () => {
  it('trims trailing slashes from the url', () => {
    expect(new RemoteDataset({ url: `${URL_BASE}//` }).url).toBe(URL_BASE);
  });

  it('has no url without one, and keeps the name and id forms', () => {
    const prev = process.env.DATA_ROOT;
    process.env.DATA_ROOT = 'http://data.test';
    try {
      expect(new RemoteDataset().url).toBeUndefined();
      expect(new RemoteDataset('main').id).toBe('http://data.test/backend-api-store/main');
      expect(new RemoteDataset({ name: 'main' }).id).toBe('http://data.test/backend-api-store/main');
      expect(new RemoteDataset({ id: 'http://x.test/s' }).id).toBe('http://x.test/s');
    } finally {
      process.env.DATA_ROOT = prev;
    }
  });

  it('without a url, init() resolves at once and fetches nothing', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));
    await expect(new RemoteDataset({ token: TOKEN }).init()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('without a url, queries go through Server.call and ignore the token', async () => {
    const calls = stubFetch(() => jsonResponse(200, null));
    const serverCalls: any[] = [];
    (Server as any).call = async (...args: any[]) => {
      serverCalls.push(args);
      return true;
    };
    const query = AskBuilder.forNode(IRI);
    await expect(new RemoteDataset({ token: TOKEN }).askQuery(query)).resolves.toBe(true);
    expect(calls).toHaveLength(0);
    expect(serverCalls).toEqual([[packageName, { method: 'askQuery', rejectOnError: true }, query.toJSON()]]);
  });
});

describe('RemoteDataset url form: query methods', () => {
  it('selectQuery posts {args: [json]} with the bearer token and resolves the body', async () => {
    const rows = [{ id: IRI, label: 'one' }];
    const calls = stubFetch(() => jsonResponse(200, rows));
    const query = SelectBuilder.from(NodeShape).for(IRI);

    await expect(store().selectQuery(query as any)).resolves.toEqual(rows);
    expect(calls).toHaveLength(1);
    expectWire(calls[0], 'selectQuery', [query.toJSON()]);
  });

  it('a count goes through selectQuery and resolves to the number', async () => {
    const calls = stubFetch(() => jsonResponse(200, 7));
    const count = queryJson({ v: '1.1', op: 'count', shape: IRI });

    await expect(store().selectQuery(count)).resolves.toBe(7);
    expectWire(calls[0], 'selectQuery', [count.toJSON()]);
  });

  it('askQuery posts to askQuery and resolves the boolean', async () => {
    const calls = stubFetch(() => jsonResponse(200, false));
    const query = AskBuilder.forNode(IRI);

    await expect(store().askQuery(query)).resolves.toBe(false);
    expectWire(calls[0], 'askQuery', [query.toJSON()]);
  });

  it.each([
    ['createQuery', { op: 'create', shape: IRI, id: IRI, set: {} }, { id: IRI }],
    ['updateQuery', { op: 'update', shape: IRI, subject: IRI, set: { label: 'two' } }, { id: IRI }],
    ['deleteQuery', { op: 'delete', shape: IRI, ids: [IRI] }, { deleted: [{ id: IRI }], count: 1 }],
  ] as const)('%s posts to its own method', async (method, json, result) => {
    const calls = stubFetch(() => jsonResponse(200, result));
    const query = queryJson(json);

    await expect((store() as any)[method](query)).resolves.toEqual(result);
    expectWire(calls[0], method, [json]);
  });

  it('a null body is a valid result', async () => {
    stubFetch(() => jsonResponse(200, null));
    await expect(store().updateQuery(queryJson({ op: 'update' }))).resolves.toBeNull();
  });

  it('sends no Authorization header without a token', async () => {
    const calls = stubFetch(() => jsonResponse(200, []));
    await store({ token: '' }).selectQuery(queryJson({ op: 'select' }));
    await new RemoteDataset({ url: URL_BASE }).selectQuery(queryJson({ op: 'select' }));
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).Authorization).toBeUndefined();
    }
  });

  it('never goes through Server or its local server', async () => {
    const localServer = { callBackendMethod: jest.fn(async () => ['local']) };
    const previous = Server.getLocalServer();
    Server.setLocalServer(localServer as any);
    const serverCall = jest.fn(async () => ['proxy']);
    (Server as any).call = serverCall;
    try {
      const calls = stubFetch(() => jsonResponse(200, ['remote']));
      await expect(store().selectQuery(queryJson({ op: 'select' }))).resolves.toEqual(['remote']);
      await store().init();
      expect(calls).toHaveLength(2);
      expect(localServer.callBackendMethod).not.toHaveBeenCalled();
      expect(serverCall).not.toHaveBeenCalled();
    } finally {
      Server.setLocalServer(previous);
    }
  });

  it('does not retry a failed write', async () => {
    const calls = stubFetch(() => jsonResponse(503, { error: 'busy' }));
    await caught(store().createQuery(queryJson({ op: 'create' })));
    expect(calls).toHaveLength(1);
  });
});

describe('RemoteDataset url form: init()', () => {
  it('pings with {args: []} and memoizes a success', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));
    const s = store();
    await expect(s.init()).resolves.toEqual({ ok: true });
    await s.init();
    expect(calls).toHaveLength(1);
    expectWire(calls[0], 'ping', []);
  });

  it('resolves the ping body and keeps it as info', async () => {
    const body = { ok: true, projectId: 'p1', branchName: 'change-1', dataset: 'acme-shop-data', forked: false };
    stubFetch(() => jsonResponse(200, body));
    const s = store();
    expect(s.info).toBeUndefined();
    const info = await s.init();
    expect(info).toEqual(body);
    expect(s.info).toBe(info);
    expect(Object.isFrozen(s.info)).toBe(true);
    await expect(s.init()).resolves.toBe(info);
  });

  it('a ping body that is not an object reads as {}', async () => {
    stubFetch(() => jsonResponse(200, null));
    const s = store();
    await expect(s.init()).resolves.toEqual({});
    expect(s.info).toEqual({});
  });

  it('the no-url form resolves undefined and has no info', async () => {
    const s = new RemoteDataset();
    await expect(s.init()).resolves.toBeUndefined();
    expect(s.info).toBeUndefined();
  });

  it('asks again on the next init() after a failure', async () => {
    let up = false;
    const calls = stubFetch(() => {
      if (!up) throw new TypeError('fetch failed');
      return jsonResponse(200, { ok: true });
    });
    const s = store();
    await expect(s.init()).rejects.toBeInstanceOf(RemoteDatasetUnreachableError);
    up = true;
    expect(s.info).toBeUndefined();
    await expect(s.init()).resolves.toEqual({ ok: true });
    await s.init();
    expect(calls).toHaveLength(2);
  });

  it('a network error is RemoteDatasetUnreachableError with the url and status 0', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await caught(store().init());
    expect(err).toBeInstanceOf(RemoteDatasetUnreachableError);
    expect(err).toBeInstanceOf(RemoteDatasetError);
    expect(err.url).toBe(URL_BASE);
    expect(err.status).toBe(0);
    expect(err.message).toContain(URL_BASE);
    expect(err.message).toContain('ping');
  });

  it.each([404, 501, 502, 503, 504])('a %i on ping is RemoteDatasetUnreachableError', async (status) => {
    stubFetch(() => jsonResponse(status, { error: 'nope' }));
    const err = await caught(store().init());
    expect(err).toBeInstanceOf(RemoteDatasetUnreachableError);
    expect(err.url).toBe(URL_BASE);
    expect(err.status).toBe(status);
  });

  it('a ping answer that is not JSON is RemoteDatasetUnreachableError', async () => {
    stubFetch(() => textResponse(200, '<html>not a linked server</html>'));
    const err = await caught(store().init());
    expect(err).toBeInstanceOf(RemoteDatasetUnreachableError);
    expect(err.status).toBe(200);

    stubFetch(() => textResponse(500, '<html>proxy error</html>'));
    expect(await caught(store().init())).toBeInstanceOf(RemoteDatasetUnreachableError);
  });

  it.each([401, 403])('a %i is RemoteDatasetUnauthorizedError, on ping and on a query', async (status) => {
    stubFetch(() => jsonResponse(status, { error: 'refused', code: 'invalid-credential' }));
    const onPing = await caught(store().init());
    expect(onPing).toBeInstanceOf(RemoteDatasetUnauthorizedError);
    expect(onPing.url).toBe(URL_BASE);
    expect(onPing.status).toBe(status);
    expect(onPing.code).toBe('invalid-credential');

    const onQuery = await caught(store().selectQuery(queryJson({ op: 'select' })));
    expect(onQuery).toBeInstanceOf(RemoteDatasetUnauthorizedError);
  });
});

describe('RemoteDataset url form: other errors', () => {
  it('a 503 with a code on a query is RemoteDatasetError with status and code', async () => {
    stubFetch(() => jsonResponse(503, { error: 'could not fork the branch', code: 'fork-failed' }));
    const err = await caught(store().updateQuery(queryJson({ op: 'update' })));
    expect(err).toBeInstanceOf(RemoteDatasetError);
    expect(err).not.toBeInstanceOf(RemoteDatasetUnreachableError);
    expect(err).not.toBeInstanceOf(RemoteDatasetUnauthorizedError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('fork-failed');
    expect(err.url).toBe(URL_BASE);
    expect(err.message).toContain('updateQuery');
    expect(err.message).toContain('could not fork the branch');
  });

  it('a 404 on a query is a plain RemoteDatasetError without a code', async () => {
    stubFetch(() => jsonResponse(404, { error: 'not found' }));
    const err = await caught(store().selectQuery(queryJson({ op: 'select' })));
    expect(err.constructor).toBe(RemoteDatasetError);
    expect(err.code).toBeUndefined();
  });

  it('an empty url never falls back to the no-url form', async () => {
    const calls = stubFetch(() => jsonResponse(200, { ok: true }));
    const serverCall = jest.fn(async () => []);
    (Server as any).call = serverCall;
    const s = new RemoteDataset({ url: '', token: TOKEN });
    expect(s.url).toBe('');

    const onInit = await caught(s.init());
    expect(onInit).toBeInstanceOf(RemoteDatasetUnreachableError);
    expect(onInit.url).toBe('');
    expect(onInit.status).toBe(0);
    const onQuery = await caught(s.selectQuery(queryJson({ op: 'select' })));
    expect(onQuery).toBeInstanceOf(RemoteDatasetUnreachableError);
    expect(onQuery.url).toBe('');
    expect(calls).toHaveLength(0);
    expect(serverCall).not.toHaveBeenCalled();
  });

  it('no error message contains the token', async () => {
    const answers: Array<() => Response> = [
      () => {
        throw new TypeError('fetch failed');
      },
      () => jsonResponse(401, { error: 'invalid credential' }),
      () => jsonResponse(404, { error: 'missing' }),
      () => jsonResponse(503, { error: 'fork failed', code: 'fork-failed' }),
      () => textResponse(200, 'not json'),
    ];
    for (const answer of answers) {
      stubFetch(answer);
      for (const p of [store().init(), store().deleteQuery(queryJson({ op: 'delete' }))]) {
        const err = await caught(p);
        expect(err).toBeInstanceOf(RemoteDatasetError);
        expect(err.message).not.toContain(TOKEN);
        expect(String(err.stack)).not.toContain(TOKEN);
      }
    }
  });
});

describe('RemoteDataset url form: the user token', () => {
  const SID = 'session-1';
  const signedIn = (sid: string | undefined) => ({
    kind: 'http' as const,
    request: sid ? { linkedAuth: { sid, userAccount: { id: 'urn:acct', accountOf: { id: 'https://u.test/me' } } } } : {},
    response: {},
  });
  const sentHeaders = (call: Call) => call.init.headers as Record<string, string>;
  const hooks = globalThis as unknown as Record<symbol, unknown>;
  let seen: Array<{ request: any; target: { method: string; url: string } }>;
  let proofs = 0;
  /** Install a hook like auth's: answers for a request with a session, a new proof each time. */
  const installHook = (answer?: (request: any) => unknown) => {
    seen = [];
    hooks[USER_TOKEN_HEADERS_HOOK] = async (request: any, target: { method: string; url: string }) => {
      seen.push({ request, target });
      if (answer) return answer(request);
      return request?.linkedAuth?.sid ? { [USER_TOKEN_HEADER]: 'user-at', DPoP: `proof-${++proofs}` } : undefined;
    };
  };
  afterEach(() => {
    delete hooks[USER_TOKEN_HEADERS_HOOK];
  });

  it("sends the hook's token and proof beside the bearer, with the request's method and URL", async () => {
    expect(USER_TOKEN_HEADER).toBe('x-linked-user-token');
    expect(USER_TOKEN_HEADERS_HOOK).toBe(Symbol.for('@_linked/auth:userTokenHeaders'));
    installHook();
    const calls = stubFetch(() => jsonResponse(200, true));
    const query = AskBuilder.forNode(IRI);
    await runWithCallContext(signedIn(SID), async () => {
      await store().askQuery(query);
      await store().askQuery(query);
    });
    expect(sentHeaders(calls[0])[USER_TOKEN_HEADER]).toBe('user-at');
    expect(sentHeaders(calls[0]).DPoP).toBe('proof-' + (proofs - 1));
    expect(sentHeaders(calls[1]).DPoP).toBe('proof-' + proofs);
    expect(sentHeaders(calls[0]).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].request.linkedAuth.sid).toBe(SID);
    expect(seen[0].target).toEqual({ method: 'POST', url: `${URL_BASE}/call/@_linked/server/askQuery` });
  });

  it('sends neither in a system context, for an anonymous request, outside any call, or without the hook', async () => {
    installHook();
    const calls = stubFetch(() => jsonResponse(200, true));
    const query = AskBuilder.forNode(IRI);
    // A system context opened from inside a signed-in request still has no user.
    await runWithCallContext(signedIn(SID), () => runAsSystem(() => store().askQuery(query), 'job'));
    await runWithCallContext(signedIn(undefined), () => store().askQuery(query));
    await store().askQuery(query);
    delete hooks[USER_TOKEN_HEADERS_HOOK];
    await runWithCallContext(signedIn(SID), () => store().askQuery(query));
    expect(calls).toHaveLength(4);
    for (const call of calls) expectWire(call, 'askQuery', [query.toJSON()]);
  });

  it('a hook that throws or answers something else sends neither; the query still goes, one warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = stubFetch(() => jsonResponse(200, true));
    const query = AskBuilder.forNode(IRI);
    const answers: Array<(request: any) => unknown> = [
      () => {
        throw new Error('broken');
      },
      () => ({ [USER_TOKEN_HEADER]: 'user-at' }),
      () => ({ [USER_TOKEN_HEADER]: '', DPoP: 'p' }),
      () => 'nonsense',
      () => null,
    ];
    for (const answer of answers) {
      installHook(answer);
      await runWithCallContext(signedIn(SID), () => store().askQuery(query));
    }
    expect(calls).toHaveLength(answers.length);
    for (const call of calls) expectWire(call, 'askQuery', [query.toJSON()]);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('user-at');
  });

  it('imports nothing server-only: the no-url form runs in the browser', async () => {
    const { readFile } = await import('fs/promises');
    const source = await readFile(new URL('../shapes/quadstores/RemoteDataset.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.filter((m) => /CallContext|async_hooks|^node:|^fs|^path$|@_linked\/auth/.test(m))).toEqual([]);
  });

  it('forwardUserToken: false (or "false") sends neither and never asks the hook', async () => {
    installHook();
    const calls = stubFetch(() => jsonResponse(200, true));
    const query = AskBuilder.forNode(IRI);
    expect(store().forwardUserToken).toBe(true);
    await runWithCallContext(signedIn(SID), async () => {
      await store({ forwardUserToken: false }).askQuery(query);
      await store({ forwardUserToken: 'false' }).askQuery(query);
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) expectWire(call, 'askQuery', [query.toJSON()]);
    expect(seen).toHaveLength(0);
  });

  it('no error message contains the user token or the proof', async () => {
    installHook();
    stubFetch(() => jsonResponse(401, { error: 'invalid user token', code: 'invalid-user-token' }));
    const err = await runWithCallContext(signedIn(SID), () => caught(store().askQuery(AskBuilder.forNode(IRI))));
    expect(err).toBeInstanceOf(RemoteDatasetError);
    expect(err.message).not.toContain('user-at');
    expect(err.message).not.toContain('proof-');
  });
});

describe('ping over the call routes', () => {
  let server: any;
  let base: string;

  beforeAll(async () => {
    const linkedServer: any = Object.create(LinkedServer.prototype);
    linkedServer.genericProviders = new Map();
    linkedServer.shapeProviders = new Map();
    linkedServer.initRequest = async () => {};
    const provider: any = Object.create(LincdServerBackendProvider.prototype);
    provider.initRequest = () => {};
    linkedServer.genericProviders.set(packageName, provider);

    const app = express();
    app.use(express.json());
    registerCallRoutes(app, linkedServer);
    server = await new Promise<any>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers 200 {ok: true}', async () => {
    const res = await fetch(`${base}/call/@_linked/server/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('lets a RemoteDataset pointed at the server init()', async () => {
    await expect(new RemoteDataset({ url: `${base}/` }).init()).resolves.toEqual({ ok: true });
  });
});
