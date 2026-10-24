import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';

// The control channel's secret (`APP_ADMIN_SECRET`, with the deprecated `CN_APP_ADMIN_SECRET`
// and `x-cn-admin-secret` still read) and `GET /admin/routes`, which answers the graph routes
// core's routing holds, read from real `LinkedStorage` pins on stub datasets.

process.env.SITE_ROOT ??= 'http://app.test:4000';
const {
  registerAdminRoutes,
  resolveAdminSecret,
  ADMIN_SECRET_HEADER,
  LEGACY_ADMIN_SECRET_HEADER,
} = await import('../utils/adminChannel.js');
const { effectiveGraphRoutes } = await import('../utils/effectiveRoutes.js');
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
const { OntologyGraph, ShapesGraph, NamedGraph } = await import('@_linked/core/shapes/NamedGraph');

const SECRET = 'routes-s3cret';
const GRAPH = 'https://example.org/data/graph/ontologies';
const servers: any[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

class AppStore {}
class OtherStore {
  id = 'https://example.org/data/backend-api-store/other';
}
const appStore = new AppStore() as any;
const otherStore = new OtherStore() as any;
LinkedStorage.setDefaultDataset(appStore);
LinkedStorage.setDatasetForShapes(otherStore, [OntologyGraph], { graph: GRAPH });
LinkedStorage.setDatasetForShapes(otherStore, ShapesGraph);

async function serve(secret: string | undefined, warn?: (m: string) => void): Promise<string> {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app, secret, {
    exit: () => {},
    syncShapes: async () => ({ written: 0 }),
    ...(warn ? { warn } : {}),
  });
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const getRoutes = (base: string, headers: Record<string, string> = { [ADMIN_SECRET_HEADER]: SECRET }) =>
  fetch(`${base}/admin/routes`, { headers });

describe('effectiveGraphRoutes', () => {
  it('lists every dataset with its routes and its default-graph shapes', () => {
    const { datasets } = effectiveGraphRoutes();
    expect(datasets.map((d) => d.store)).toEqual(['AppStore', 'OtherStore']);
    const [app, other] = datasets;
    expect(app.default).toBe(true);
    expect(app.routes).toEqual({});
    expect(app.id).toBeUndefined();
    expect(app.defaultGraphShapes).toContain(NamedGraph.shape.id);
    expect(app.defaultGraphShapes).not.toContain(OntologyGraph.shape.id);
    expect(app.defaultGraphShapes).not.toContain(ShapesGraph.shape.id);
    expect(other).toEqual({
      store: 'OtherStore',
      id: 'https://example.org/data/backend-api-store/other',
      default: false,
      routes: { [OntologyGraph.shape.id]: GRAPH },
      defaultGraphShapes: [ShapesGraph.shape.id],
    });
    expect([...app.defaultGraphShapes].sort()).toEqual(app.defaultGraphShapes);
  });
});

describe('GET /admin/routes', () => {
  it('answers the effective routes with the secret', async () => {
    const base = await serve(SECRET);
    const res = await getRoutes(base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(effectiveGraphRoutes())));
  });

  it('answers 404 without a configured secret, and 401 for a wrong or missing one', async () => {
    expect((await getRoutes(await serve(undefined))).status).toBe(404);
    const base = await serve(SECRET);
    expect((await getRoutes(base, { [ADMIN_SECRET_HEADER]: 'wrong-secret!' })).status).toBe(401);
    expect((await getRoutes(base, {})).status).toBe(401);
  });

  it('accepts the deprecated header and warns once', async () => {
    const warnings: string[] = [];
    const base = await serve(SECRET, (m) => warnings.push(m));
    expect((await getRoutes(base, { [LEGACY_ADMIN_SECRET_HEADER]: SECRET })).status).toBe(200);
    expect((await getRoutes(base, { [LEGACY_ADMIN_SECRET_HEADER]: SECRET })).status).toBe(200);
    expect((await getRoutes(base)).status).toBe(200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/x-cn-admin-secret.*deprecated.*x-app-admin-secret/);
  });
});

describe('resolveAdminSecret', () => {
  it('reads APP_ADMIN_SECRET without a warning, and nothing when neither name is set', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(resolveAdminSecret({ APP_ADMIN_SECRET: 'new' }, warn)).toBe('new');
    expect(resolveAdminSecret({ APP_ADMIN_SECRET: 'new', CN_APP_ADMIN_SECRET: 'old' }, warn)).toBe('new');
    expect(resolveAdminSecret({}, warn)).toBeUndefined();
    expect(resolveAdminSecret({ APP_ADMIN_SECRET: '' }, warn)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('falls back to CN_APP_ADMIN_SECRET and logs the deprecation once per process', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(resolveAdminSecret({ CN_APP_ADMIN_SECRET: 'old' }, warn)).toBe('old');
    expect(resolveAdminSecret({ CN_APP_ADMIN_SECRET: 'old' }, warn)).toBe('old');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/CN_APP_ADMIN_SECRET is deprecated; set APP_ADMIN_SECRET/);
    const later: string[] = [];
    expect(resolveAdminSecret({ CN_APP_ADMIN_SECRET: 'old' }, (m) => later.push(m))).toBe('old');
    expect(later).toEqual([]);
  });

  it('a channel opened with either name answers the route', async () => {
    for (const env of [{ APP_ADMIN_SECRET: SECRET }, { CN_APP_ADMIN_SECRET: SECRET }]) {
      const base = await serve(resolveAdminSecret(env, () => {}));
      expect((await getRoutes(base)).status).toBe(200);
    }
  });
});
