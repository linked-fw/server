import { describe, expect, it } from '@jest/globals';
import { SelectBuilder } from '@_linked/core/queries/QueryBuilder';
import { AskBuilder } from '@_linked/core/queries/AskBuilder';
import { NodeShape } from '@_linked/core/shapes/SHACL';
import {
  GATEWAY_WIRE_VERSION,
  GatewayStore,
  GatewayStoreError,
  GatewayUnreachableError,
} from '../shapes/quadstores/GatewayStore.js';

// The store is a thin HTTP client: every query goes out as `{v, op, query: toJSON()}` with the
// bearer credential, and the body's `result` comes back untouched. These tests pin the wire
// shape and the error mapping with a fake fetch; no gateway runs.

const ENDPOINT = 'http://cn.test:4040/gateway';
const SECRET = 'a'.repeat(64);
const IRI = 'http://example.org/shape-1';

type Call = { url: string; init: RequestInit };

// The store reads nothing from a query but `toJSON()`. The mutation builders and the count
// envelope refuse to serialize without a registered shape, which no test here boots, so those
// ops use a stand-in that returns the DSL-JSON a real builder would.
function queryJson(json: Record<string, unknown>) {
  return { toJSON: () => json } as any;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function store(fetchImpl: typeof fetch, config: Partial<{ endpoint: string; credential: string }> = {}) {
  return new GatewayStore({ endpoint: ENDPOINT, credential: SECRET, ...config, fetch: fetchImpl });
}

function sentBody(call: Call): any {
  return JSON.parse(String(call.init.body));
}

function expectWire(call: Call, op: string, json: unknown) {
  expect(call.url).toBe(`${ENDPOINT}/query`);
  expect(call.init.method).toBe('POST');
  const headers = call.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
  expect(headers['Content-Type']).toBe('application/json');
  expect(sentBody(call)).toEqual({ v: GATEWAY_WIRE_VERSION, op, query: json });
}

describe('GatewayStore constructor', () => {
  it('throws at once when the endpoint is empty', () => {
    expect(() => new GatewayStore({ endpoint: '', credential: SECRET })).toThrow(/endpoint/);
    expect(() => new GatewayStore({ endpoint: '   ', credential: SECRET })).toThrow(/endpoint/);
  });

  it('throws at once when the credential is empty', () => {
    expect(() => new GatewayStore({ endpoint: ENDPOINT, credential: '' })).toThrow(/credential/);
  });

  it('strips a trailing slash from the endpoint', () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { result: [] }));
    expect(store(fetchImpl, { endpoint: `${ENDPOINT}/` }).endpoint).toBe(ENDPOINT);
  });
});

describe('GatewayStore query methods', () => {
  it('selectQuery posts op "select" with the query JSON and returns the result', async () => {
    const rows = [{ id: IRI, label: 'one' }];
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { result: rows }));
    const query = SelectBuilder.from(NodeShape).for(IRI);

    await expect(store(fetchImpl).selectQuery(query as any)).resolves.toEqual(rows);
    expect(calls).toHaveLength(1);
    expectWire(calls[0], 'select', query.toJSON());
  });

  it('a count arrives through selectQuery with op "select" and resolves to the number', async () => {
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { result: 7 }));
    const count = queryJson({ v: GATEWAY_WIRE_VERSION, op: 'count', shape: IRI });

    await expect(store(fetchImpl).selectQuery(count as any)).resolves.toBe(7);
    expectWire(calls[0], 'select', count.toJSON());
    expect(sentBody(calls[0]).query.op).toBe('count');
  });

  it('askQuery posts op "ask" and returns the boolean', async () => {
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { result: true }));
    const query = AskBuilder.forNode(IRI);

    await expect(store(fetchImpl).askQuery(query)).resolves.toBe(true);
    expectWire(calls[0], 'ask', query.toJSON());
  });

  it('createQuery posts op "create"', async () => {
    const created = { id: IRI };
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { result: created }));
    const query = queryJson({ v: GATEWAY_WIRE_VERSION, op: 'create', shape: IRI, id: IRI, set: {} });

    await expect(store(fetchImpl).createQuery(query)).resolves.toEqual(created);
    expectWire(calls[0], 'create', query.toJSON());
  });

  it('updateQuery posts op "update"', async () => {
    const updated = { id: IRI, label: 'two' };
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { result: updated }));
    const query = queryJson({ v: GATEWAY_WIRE_VERSION, op: 'update', shape: IRI, subject: IRI, set: { label: 'two' } });

    await expect(store(fetchImpl).updateQuery(query)).resolves.toEqual(updated);
    expectWire(calls[0], 'update', query.toJSON());
  });

  it('deleteQuery posts op "delete"', async () => {
    const deleted = { deleted: 1 };
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { result: deleted }));
    const query = queryJson({ v: GATEWAY_WIRE_VERSION, op: 'delete', shape: IRI, subject: IRI });

    await expect(store(fetchImpl).deleteQuery(query)).resolves.toEqual(deleted);
    expectWire(calls[0], 'delete', query.toJSON());
  });

  it('a 200 without a result field is a GatewayStoreError', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { ok: true }));
    const err = await store(fetchImpl)
      .askQuery(AskBuilder.forNode(IRI))
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayStoreError);
    expect(err.code).toBe('bad-response');
  });
});

describe('GatewayStore.init', () => {
  it('gets {endpoint}/health with the bearer header and resolves with the answer', async () => {
    const health = { projectId: 'p', branchName: 'main', dataset: 'ws-p-main' };
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, health));

    await expect(store(fetchImpl).init()).resolves.toEqual(health);
    expect(calls[0].url).toBe(`${ENDPOINT}/health`);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as any).Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('is idempotent: a second init pings again and resolves', async () => {
    const { calls, fetchImpl } = fakeFetch(() => jsonResponse(200, { projectId: 'p' }));
    const s = store(fetchImpl);
    await s.init();
    await s.init();
    expect(calls).toHaveLength(2);
  });

  it('maps 401 to GatewayUnreachableError with the body code', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(401, { error: 'unknown credential', code: 'invalid-credential' }),
    );
    const err = await store(fetchImpl).init().catch((e) => e);
    expect(err).toBeInstanceOf(GatewayUnreachableError);
    expect(err).toBeInstanceOf(GatewayStoreError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('invalid-credential');
    expect(err.message).toMatch(/401/);
  });

  it('maps a network failure to GatewayUnreachableError', async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await store(fetchImpl).init().catch((e) => e);
    expect(err).toBeInstanceOf(GatewayUnreachableError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('unreachable');
    expect(err.message).toMatch(/fetch failed/);
    expect(err.message).toContain(`${ENDPOINT}/health`);
  });
});

describe('GatewayStore error mapping on queries', () => {
  it('401 on a query is GatewayUnreachableError', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(401, { error: 'revoked', code: 'invalid-credential' }));
    const err = await store(fetchImpl).askQuery(AskBuilder.forNode(IRI)).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayUnreachableError);
    expect(err.code).toBe('invalid-credential');
  });

  it('503 fork-failed is a GatewayStoreError carrying the code, status and body', async () => {
    const body = { error: 'dataset name collision', code: 'fork-failed' };
    const { fetchImpl } = fakeFetch(() => jsonResponse(503, body));
    const err = await store(fetchImpl)
      .createQuery(queryJson({ v: GATEWAY_WIRE_VERSION, op: 'create', shape: IRI, set: {} }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayStoreError);
    expect(err).not.toBeInstanceOf(GatewayUnreachableError);
    expect(err.status).toBe(503);
    expect(err.code).toBe('fork-failed');
    expect(err.body).toEqual(body);
    expect(err.message).toMatch(/503 \(fork-failed\): dataset name collision/);
  });

  it('403 refused and 400 unknown-shape keep their codes', async () => {
    for (const [status, code] of [
      [403, 'refused'],
      [400, 'unknown-shape'],
    ] as const) {
      const { fetchImpl } = fakeFetch(() => jsonResponse(status, { error: 'x', code }));
      const err = await store(fetchImpl).askQuery(AskBuilder.forNode(IRI)).catch((e) => e);
      expect(err).toBeInstanceOf(GatewayStoreError);
      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
    }
  });

  it('a non-JSON error body falls back to an http-<status> code', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } }),
    );
    const err = await store(fetchImpl).askQuery(AskBuilder.forNode(IRI)).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayStoreError);
    expect(err.code).toBe('http-502');
    expect(err.body).toBe('Bad Gateway');
  });
});
