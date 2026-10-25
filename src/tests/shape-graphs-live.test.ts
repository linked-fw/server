import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// [fuseki] The server's shape sync on an inferring Fuseki (image `6.2.0-2`), through the boot's
// own methods: the ontology phase, then the shape sync. An installed package with a built
// `shapes.ttl` gets its shape graph from that file; an installed package without one gets none
// (nothing is generated for it); the app's own workspace package is generated in process; the
// app's single-owner shapes go in `{DATA_ROOT}/graph/shapes`. The boot logs the graphs it
// writes; a second boot writes nothing; the control channel's `POST /admin/sync-shapes`
// reports the shape graphs. Runs only when FUSEKI_BASE_URL names a store; it creates its own
// dataset there and deletes it afterwards.

const FUSEKI = process.env.FUSEKI_BASE_URL;
const describeLive = FUSEKI ? describe : describe.skip;
const ADMIN = `Basic ${Buffer.from(`admin:${process.env.FUSEKI_ADMIN_PASSWORD || 'admin'}`).toString('base64')}`;
const DATASET = `server-shape-graphs-${process.pid}-${Date.now()}`;
const SECRET = 'live-admin-secret';
const DATA_ROOT = 'https://sg-app.test/data';

process.env.SITE_ROOT ??= 'http://app.test:4000';
process.env.DATA_ROOT = DATA_ROOT;
delete process.env.LINKED_SYNC_SHAPES_ON_BOOT;
delete process.env.LINKED_SYNC_SHAPES_PRUNE_ORPHANS;
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
const { SparqlDataset } = await import('@_linked/core/sparql/SparqlDataset');
const { linkedPackage } = await import('@_linked/core/utils/Package');
const { Shape } = await import('@_linked/core/shapes/Shape');
const { literalProperty, objectProperty } = await import('@_linked/core/shapes/SHACL');
const { ShapesGraph } = await import('@_linked/core/shapes/NamedGraph');
const { packageShapesTurtle } = await import('@_linked/core/shapes/shapesToTurtle');
const { syncShape } = await import('@_linked/core/shapes/syncShapes');
const { withAccess } = await import('@_linked/server-utils/utils/QueryAccess');
const { LinkedServer } = await import('../shapes/LinkedServer.js');
const { registerAdminRoutes } = await import('../utils/adminChannel.js');

/** A Fuseki dataset over plain HTTP that counts its updates. */
class LiveFuseki extends (SparqlDataset as any) {
  updates = 0;
  constructor(private readonly endpoint: string) {
    super({});
  }
  async executeSparqlSelect(query: string) {
    const res = await fetch(`${this.endpoint}/sparql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-query', Accept: 'application/sparql-results+json' },
      body: query,
    });
    if (!res.ok) throw new Error(`select ${res.status}: ${await res.text()}`);
    return res.json();
  }
  async executeSparqlUpdate(update: string) {
    this.updates++;
    const res = await fetch(`${this.endpoint}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: update,
    });
    if (!res.ok) throw new Error(`update ${res.status}: ${await res.text()}`);
  }
  async init() {}
}

const EX = 'http://example.org/server-shape-graphs/';
const BUILT = 'server-sg-built';
const BARE = 'server-sg-bare';
const OWN = 'server-sg-own';
const APP = 'server-sg-app';

let BookClass: any;
let ShelfClass: any;
{
  const { linkedShape } = linkedPackage(BUILT);
  @linkedShape
  class SgBook extends Shape {
    static targetClass = { id: `${EX}Book` };
    @literalProperty({ path: { id: `${EX}title` }, maxCount: 1 })
    get title(): string {
      return '';
    }
  }
  BookClass = SgBook;
}
let bareShape = '';
{
  const { linkedShape } = linkedPackage(BARE);
  @linkedShape
  class SgShelf extends Shape {
    static targetClass = { id: `${EX}Shelf` };
    @literalProperty({ path: { id: `${EX}shelfName` }, maxCount: 1 })
    get shelfName(): string {
      return '';
    }
  }
  ShelfClass = SgShelf;
  bareShape = SgShelf.shape.id;
}
{
  const { linkedShape } = linkedPackage(OWN);
  @linkedShape
  class SgChapter extends Shape {
    static targetClass = { id: `${EX}Chapter` };
    @literalProperty({ path: { id: `${EX}heading` }, maxCount: 1 })
    get heading(): string {
      return '';
    }
  }
  @linkedShape
  class SgManuscript extends Shape {
    static targetClass = { id: `${EX}Manuscript` };
    @objectProperty({ path: { id: `${EX}chapter` }, shape: SgChapter, contains: true })
    get chapters(): unknown {
      return null;
    }
  }
  void SgManuscript;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-shape-graphs-'));
/** A package root with a package.json, and `shapes.ttl` when given. */
function packageDir(name: string, turtle?: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', linkedPackage: true }));
  if (turtle !== undefined) {
    fs.mkdirSync(path.join(dir, 'lib/esm/data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib/esm/data/shapes.ttl'), turtle);
  }
  return dir;
}

const servers: any[] = [];
let store: InstanceType<typeof LiveFuseki>;
let server: any;

async function admin(p: string, init: RequestInit) {
  return fetch(`${FUSEKI}${p}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: ADMIN } });
}
async function ask(query: string): Promise<boolean> {
  return (await store.executeSparqlSelect(query)).boolean;
}

const REG = 'https://linked.cm/pkg/core/graph/registry';
const CORE = 'https://linked.cm/ont/core/';
const APP_GRAPH = `${DATA_ROOT}/graph/shapes`;

describeLive('[fuseki] shape graphs at boot and on the control channel', () => {
  beforeAll(async () => {
    const created = await admin('/$/datasets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `dbName=${DATASET}&dbType=tdb2`,
    });
    expect(created.status).toBe(200);
    store = new LiveFuseki(`${FUSEKI}/${DATASET}`);
    LinkedStorage.setDefaultDataset(
      withAccess(store as any, { read: () => true, write: () => true, graph: () => true }) as any,
    );
    // What `linked build` writes for the built package: its shapes as Turtle.
    const builtTurtle = packageShapesTurtle(BUILT);
    expect(builtTurtle).toBeDefined();
    server = Object.create(LinkedServer.prototype);
    Object.assign(server, {
      config: { server: {} },
      package: { name: APP },
      linkedPackageDirs: new Map([
        [BUILT, packageDir(BUILT, builtTurtle)],
        [BARE, packageDir(BARE)],
        [OWN, packageDir(OWN)],
        // The core and the server this test runs on, as installed packages without shapes.ttl.
        ['@_linked/core', packageDir('core-without-shapes-ttl')],
        ['@_linked/server', packageDir('server-without-shapes-ttl')],
      ]),
      workspacePackageDirs: [],
      workspacePackageNames: new Set([OWN]),
      shapeSyncQueue: Promise.resolve(),
    });
  });

  afterAll(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    if (FUSEKI) await admin(`/$/datasets/${DATASET}`, { method: 'DELETE' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the boot writes and logs the shape graphs, a second boot writes nothing, the route reports them', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const lines: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((m: unknown) => {
      lines.push(String(m));
      process.stdout.write(`${m}\n`);
    });
    // What the default-graph shape sync of an earlier server wrote.
    const bookShape = BookClass.shape.id;
    for (const shape of [BookClass, ShelfClass]) await syncShape(shape, store as any, { force: true })();
    expect(await ask(`ASK { <${bookShape}> <${CORE}shapeHash> ?h }`)).toBe(true);
    expect(await ask(`ASK { <${bareShape}> <${CORE}shapeHash> ?h }`)).toBe(true);

    const boot = async () => {
      const t0 = Date.now();
      await server.syncOntologiesOnBoot();
      await server.materializeShapesIntoStore();
      return Date.now() - t0;
    };

    // First boot.
    const firstMs = await boot();
    const firstLine = lines.find((l) => l.includes('shape graph sync'));
    expect(firstLine).toBeDefined();
    const builtGraph = ShapesGraph.iriFor(BUILT);
    const ownGraph = ShapesGraph.iriFor(OWN);
    expect(firstLine).toBe(
      `[LinkedServer] shape graph sync: written ${BUILT}, ${OWN}; app graph written; ` +
        `graphs written ${builtGraph}, ${ownGraph}, ${APP_GRAPH}; 1 default-graph shape(s) removed; ` +
        `no shapes.ttl (no shape graph): @_linked/core, @_linked/server, ${BARE}`,
    );
    for (const graph of [builtGraph, ownGraph, APP_GRAPH]) {
      expect(
        await ask(`ASK { GRAPH <${REG}> { <${graph}> a <${CORE}ShapesGraph> ; <${CORE}feedsHierarchy> false ; <${CORE}contentHash> ?h } }`),
      ).toBe(true);
    }
    expect(await ask(`ASK { GRAPH <${REG}> { <${builtGraph}> <${CORE}package> "${BUILT}" } }`)).toBe(true);
    expect(await ask(`ASK { GRAPH <${REG}> { <${APP_GRAPH}> <${CORE}package> "${APP}" } }`)).toBe(true);
    // The built package's graph holds its shapes; the app graph the generated single-owner shape.
    expect(await ask(`ASK { GRAPH <${builtGraph}> { ?s <http://www.w3.org/ns/shacl#targetClass> <${EX}Book> } }`)).toBe(true);
    expect(await ask(`ASK { GRAPH <${APP_GRAPH}> { ?s <${CORE}generatedShape> ?g } }`)).toBe(true);
    // No graph and no record for a package without shapes.ttl (core and the server here too).
    for (const pkg of [BARE, '@_linked/core', '@_linked/server']) {
      const graph = ShapesGraph.iriFor(pkg);
      expect(await ask(`ASK { { GRAPH <${graph}> { ?s ?p ?o } } UNION { GRAPH <${REG}> { <${graph}> ?p ?o } } }`)).toBe(false);
    }
    // The built package's default-graph shape is gone; the bare package is not part of the run,
    // so its default-graph shape stays.
    expect(await ask(`ASK { <${bookShape}> <${CORE}shapeHash> ?h }`)).toBe(false);
    expect(await ask(`ASK { <${bareShape}> <${CORE}shapeHash> ?h }`)).toBe(true);

    // Second boot: every graph skipped, no update at all.
    lines.length = 0;
    const before = store.updates;
    const secondMs = await boot();
    const secondLine = lines.find((l) => l.includes('shape graph sync'));
    expect(secondLine).toBe(
      `[LinkedServer] shape graph sync: 2 unchanged; app graph unchanged; ` +
        `no shapes.ttl (no shape graph): @_linked/core, @_linked/server, ${BARE}`,
    );
    expect(store.updates - before).toBe(0);
    process.stdout.write(`first boot (ontology phase + shape sync) ${firstMs} ms, second ${secondMs} ms\n`);

    // The control channel reports the shape graphs.
    const app = express();
    app.use(express.json());
    registerAdminRoutes(app, SECRET, { exit: () => {}, syncShapes: (request) => server.resyncShapes(request) });
    const s = await new Promise<any>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    servers.push(s);
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/admin/sync-shapes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-admin-secret': SECRET },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toBe(0);
    expect(body.shapeGraphs).toMatchObject({
      written: [],
      skipped: [BUILT, OWN],
      pruned: [],
      graphs: [],
      appGraph: { graph: APP_GRAPH, status: 'skipped' },
      withoutTurtle: ['@_linked/core', '@_linked/server', BARE],
      cleaned: 0,
    });
    expect(body.shapes).toEqual(expect.arrayContaining([bareShape]));
    log.mockRestore();
  });
});
