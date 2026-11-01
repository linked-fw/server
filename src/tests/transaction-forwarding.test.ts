import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';
import { Shape } from '@_linked/core/shapes/Shape';
import { literalProperty } from '@_linked/core/shapes/SHACL';
import { linkedPackage } from '@_linked/core/utils/Package';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { InMemoryDataset } from '@_linked/core/memory/InMemoryDataset';
import { inTransaction } from '@_linked/core/queries/transactionQuery';
import { SparqlDataset } from '@_linked/core/sparql/SparqlDataset';
import { LinkedServer, registerCallRoutes } from '../shapes/LinkedServer.js';
import LincdServerBackendProvider from '../backend.js';
import { LincdAPI } from '../shapes/LincdAPI.js';
import { createJsonBodyParser } from '../utils/jsonBodyParser.js';
import { RemoteDataset } from '../shapes/quadstores/RemoteDataset.js';

// Store transactions behind `/call/@_linked/server` (core report 103, forwarding contract): the
// server answers its own txId, holds a core Transaction over an in-memory store that supports
// them, and binds the txId to the user who began it.

const { linkedShape } = linkedPackage('transaction-forwarding-test');
const NS = 'http://example.org/tx-forwarding-test/';

@linkedShape({ name: 'TxPerson' })
class TxPerson extends Shape {
  static targetClass = { id: NS + 'Person' };
  @literalProperty({ path: { id: NS + 'name' }, maxCount: 1 })
  get name(): string {
    return '';
  }
}

const ALICE = 'http://ex/alice';
const BOB = 'http://ex/bob';
const servers: any[] = [];

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
  // stands in for the auth provider's session middleware: `x-test-user`, or a bearer naming the user
  app.use((req: any, _res, next) => {
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const user = req.headers['x-test-user'] ?? (bearer ? `http://ex/${bearer}` : undefined);
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

async function call(base: string, method: string, args: unknown[], user?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) headers['x-test-user'] = user;
  const res = await fetch(`${base}/call/@_linked/server/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ args }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const create = (name: string, txId?: string) => {
  const q = TxPerson.create({ name });
  return (txId ? inTransaction(q, txId) : q).toJSON();
};
const selectNames = (txId?: string) => {
  const q = TxPerson.select((p: any) => p.name);
  return (txId ? inTransaction(q, txId) : q).toJSON();
};
const namesOf = (rows: any) => ((rows ?? []) as Array<{ name?: string }>).map((r) => r.name).sort();

let store: InMemoryDataset;

beforeEach(() => {
  store = new InMemoryDataset();
  LinkedStorage.setDefaultDataset(store);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('store transactions over /call', () => {
  it('ping lists transactions when every store holds them', async () => {
    const base = await listen();
    expect((await call(base, 'ping', [])).json).toEqual({ ok: true, supports: ['transactions'] });
    LinkedStorage.setDatasetForShapes(new SparqlDataset({} as any) as any, TxPerson);
    try {
      expect((await call(base, 'ping', [])).json).toEqual({ ok: true, supports: [] });
      const begun = await call(base, 'beginTransaction', [], ALICE);
      expect(begun).toMatchObject({ status: 501, json: { code: 'transactions-unsupported' } });
    } finally {
      LinkedStorage.unsetDatasetForShape(TxPerson);
    }
  });

  it('commit applies every write; until then only the transaction sees them', async () => {
    const base = await listen();
    const begun = await call(base, 'beginTransaction', [], ALICE);
    expect(begun.status).toBe(200);
    const txId = begun.json as string;
    expect(typeof txId).toBe('string');

    expect((await call(base, 'createQuery', [create('Ann', txId)], ALICE)).status).toBe(200);
    expect((await call(base, 'createQuery', [create('Ben', txId)], ALICE)).status).toBe(200);
    expect(namesOf((await call(base, 'selectQuery', [selectNames(txId)], ALICE)).json)).toEqual(['Ann', 'Ben']);
    expect(namesOf((await call(base, 'selectQuery', [selectNames()], ALICE)).json)).toEqual([]);

    expect((await call(base, 'commit', [txId], ALICE)).status).toBe(200);
    expect(namesOf((await call(base, 'selectQuery', [selectNames()], ALICE)).json)).toEqual(['Ann', 'Ben']);
    // ended: a second commit and a query with it are unknown
    expect(await call(base, 'commit', [txId], ALICE)).toMatchObject({ status: 409, json: { code: 'transaction-unknown' } });
    expect((await call(base, 'createQuery', [create('Cid', txId)], ALICE)).status).toBe(409);
  });

  it('rollback applies nothing; a rollback of an unknown txId resolves', async () => {
    const base = await listen();
    const txId = (await call(base, 'beginTransaction', [], ALICE)).json as string;
    expect((await call(base, 'createQuery', [create('Ann', txId)], ALICE)).status).toBe(200);
    expect((await call(base, 'rollback', [txId], ALICE)).status).toBe(200);
    expect(namesOf((await call(base, 'selectQuery', [selectNames()], ALICE)).json)).toEqual([]);
    expect((await call(base, 'rollback', [txId], ALICE)).status).toBe(200);
    expect((await call(base, 'rollback', ['never-begun'], ALICE)).status).toBe(200);
  });

  it("refuses another user's txId and leaves the owner's transaction as it was", async () => {
    const base = await listen();
    const txId = (await call(base, 'beginTransaction', [], ALICE)).json as string;
    expect((await call(base, 'createQuery', [create('Ann', txId)], ALICE)).status).toBe(200);

    expect(await call(base, 'createQuery', [create('Eve', txId)], BOB)).toMatchObject({ status: 403, json: { code: 'transaction-not-yours' } });
    expect(await call(base, 'selectQuery', [selectNames(txId)], BOB)).toMatchObject({ status: 403 });
    expect(await call(base, 'commit', [txId], BOB)).toMatchObject({ status: 403 });
    expect(await call(base, 'rollback', [txId], BOB)).toMatchObject({ status: 403 });
    // anonymous: a transaction needs a session
    expect((await call(base, 'createQuery', [create('Eve', txId)])).status).toBe(401);
    expect((await call(base, 'beginTransaction', [])).status).toBe(401);

    expect((await call(base, 'commit', [txId], ALICE)).status).toBe(200);
    expect(namesOf((await call(base, 'selectQuery', [selectNames()], ALICE)).json)).toEqual(['Ann']);
  });

  it('a refused query rolls the transaction back', async () => {
    const base = await listen();
    const txId = (await call(base, 'beginTransaction', [], ALICE)).json as string;
    expect((await call(base, 'createQuery', [create('Ann', txId)], ALICE)).status).toBe(200);
    // a create that chooses the id of its new node is refused by the access check
    const chosen = inTransaction(TxPerson.create({ id: 'http://ex/chosen', name: 'Zed' } as any), txId).toJSON();
    expect((await call(base, 'createQuery', [chosen], ALICE)).status).toBe(403);
    expect(await call(base, 'commit', [txId], ALICE)).toMatchObject({ status: 409, json: { code: 'transaction-unknown' } });
    expect(namesOf((await call(base, 'selectQuery', [selectNames()], ALICE)).json)).toEqual([]);
  });

  it('a query with a txId on /api is refused', async () => {
    const base = await listen();
    const txId = (await call(base, 'beginTransaction', [], ALICE)).json as string;
    const res = await fetch(`${base}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': ALICE },
      body: JSON.stringify({ query: create('Ann', txId) }),
    });
    expect(res.status).toBe(400);
    expect(namesOf((await call(base, 'selectQuery', [selectNames(txId)], ALICE)).json)).toEqual([]);
  });

  it('RemoteDataset declares transactions after a ping that lists them, and calls the three methods', async () => {
    const base = await listen();
    const remote = new RemoteDataset({ url: base, token: 'alice' });
    expect(remote.supports).toBeUndefined();
    await remote.init();
    expect(remote.supports).toEqual(['transactions']);
    const txId = await remote.beginTransaction();
    expect((await call(base, 'createQuery', [create('Ann', txId)], ALICE)).status).toBe(200);
    await remote.commit(txId);
    expect(namesOf((await call(base, 'selectQuery', [selectNames()], ALICE)).json)).toEqual(['Ann']);
    await remote.rollback(txId);
    await expect(remote.commit(txId)).rejects.toMatchObject({ status: 409, code: 'transaction-unknown' });
  });
});
