import { afterEach, describe, expect, it, jest } from '@jest/globals';

// LINKED_GRAPH_WRITER: who writes the app's shape and ontology graphs. Checked at boot (an invalid
// value is fatal); under `host` the boot and POST /admin/sync-shapes send no graph query (observed
// on core's query dispatch); GET /admin/routes reports it.

process.env.SITE_ROOT ??= 'http://app.test:4000';
const { graphWriterFromEnv, appWritesGraphs, GRAPH_WRITER_ENV } = await import('../utils/graphTargets.js');
const { effectiveGraphRoutes } = await import('../utils/effectiveRoutes.js');
const { SparqlDataset } = await import('@_linked/core/sparql/SparqlDataset');
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
const { subscribeQueryDispatch } = await import('@_linked/core/queries/queryDispatch');
const { linkedPackage } = await import('@_linked/core/utils/Package');
const { Shape } = await import('@_linked/core/shapes/Shape');
const { LinkedServer } = await import('../shapes/LinkedServer.js');
const { isFatalError } = await import('../utils/fatalError.js');

/** Answers reads empty and every graph query as done; counts the graph queries it gets. */
class Recording extends (SparqlDataset as any) {
  graphQueries = 0;
  async selectQuery() {
    return [];
  }
  async askQuery() {
    return false;
  }
  async graphQuery(query: { graph: string; contentHash?: string }) {
    this.graphQueries++;
    return { graph: query.graph, contentHash: query.contentHash, changed: true };
  }
  async executeSparqlSelect() {
    return { head: { vars: [] }, results: { bindings: [] } };
  }
  async executeSparqlUpdate() {}
}

// A package with a shape, so the app writer has a graph to write.
class GwThing extends (Shape as any) {
  static targetClass = { id: 'https://example.org/gw#Thing' };
}
(linkedPackage('gw-app').linkedShape as any)(GwThing);

const saved = process.env[GRAPH_WRITER_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[GRAPH_WRITER_ENV];
  else process.env[GRAPH_WRITER_ENV] = saved;
  jest.restoreAllMocks();
});

/** A server as the boot has it after its stores and providers, without listening. */
function server(): any {
  const s: any = Object.create(LinkedServer.prototype);
  Object.assign(s, {
    config: { server: {} },
    package: { name: 'gw-app' },
    linkedPackageDirs: new Map(),
    workspacePackageDirs: [],
    workspacePackageNames: new Set(['gw-app']),
    shapeSyncQueue: Promise.resolve(),
  });
  return s;
}

/** Run the boot's three sync steps and a sync-shapes request; count the graph queries sent. */
async function bootAndResync(): Promise<{ sent: number; received: number; resync: any; lines: string[] }> {
  const store = new (Recording as any)();
  const before = LinkedStorage.getDefaultDataset();
  LinkedStorage.setDefaultDataset(store);
  let sent = 0;
  const stop = subscribeQueryDispatch((event: { kind: string }) => {
    if (event.kind === 'graph') sent++;
  });
  const lines: string[] = [];
  jest.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const s = server();
    await s.logSyncTargets();
    await s.syncOntologiesOnBoot();
    await s.materializeShapesIntoStore();
    const resync = await s.resyncShapes();
    return { sent, received: store.graphQueries, resync, lines };
  } finally {
    stop();
    if (before) LinkedStorage.setDefaultDataset(before);
  }
}

describe('LINKED_GRAPH_WRITER', () => {
  it("is 'app' unless set to 'host'; anything else throws, naming the variable", () => {
    expect(graphWriterFromEnv({})).toBe('app');
    expect(graphWriterFromEnv({ LINKED_GRAPH_WRITER: '' })).toBe('app');
    expect(graphWriterFromEnv({ LINKED_GRAPH_WRITER: 'app' })).toBe('app');
    expect(graphWriterFromEnv({ LINKED_GRAPH_WRITER: 'host' })).toBe('host');
    expect(() => graphWriterFromEnv({ LINKED_GRAPH_WRITER: 'cn' })).toThrow(
      `LINKED_GRAPH_WRITER must be 'app' or 'host' (who writes the app's shape and ontology graphs), not "cn"`,
    );
    expect(appWritesGraphs({ LINKED_GRAPH_WRITER: 'host' })).toBe(false);
    expect(appWritesGraphs({})).toBe(true);
  });

  it('an invalid value stops the boot before any store is initialised', async () => {
    process.env[GRAPH_WRITER_ENV] = 'nobody';
    let inits = 0;
    const store = new (Recording as any)();
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(store);
    store.init = async () => {
      inits++;
    };
    try {
      const error = await new LinkedServer({} as any).initStores().catch((e: unknown) => e);
      expect(isFatalError(error)).toBe(true);
      expect(String((error as Error).message)).toContain('LINKED_GRAPH_WRITER must be');
      expect(inits).toBe(0);
    } finally {
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });

  it('the app writer: the boot and sync-shapes send graph queries (the observation sees them)', async () => {
    delete process.env[GRAPH_WRITER_ENV];
    const { sent, received, resync } = await bootAndResync();
    expect(sent).toBeGreaterThan(0);
    expect(received).toBeGreaterThan(0);
    expect(resync.skipped).toBeUndefined();
  });

  it('the host writer: no graph query at boot or on sync-shapes, which still reloads and checks', async () => {
    process.env[GRAPH_WRITER_ENV] = 'host';
    const { sent, received, resync, lines } = await bootAndResync();
    expect(sent).toBe(0);
    expect(received).toBe(0);
    expect(resync).toEqual({
      written: 0,
      skipped: 'host-writer',
      reloaded: [],
      shapes: expect.arrayContaining([GwThing.shape.id]),
      shapeCheck: expect.objectContaining({ errors: expect.any(Number), warnings: expect.any(Number) }),
    });
    expect(lines).toContain(
      '[LinkedServer] LINKED_GRAPH_WRITER=host: the host writes this app\'s shape and ontology graphs; the boot and POST /admin/sync-shapes write none (the host reads them through POST /admin/graph-content).',
    );
  });

  it('GET /admin/routes reports it', () => {
    expect(effectiveGraphRoutes({}).graphWriter).toBe('app');
    expect(effectiveGraphRoutes({ LINKED_GRAPH_WRITER: 'host' }).graphWriter).toBe('host');
  });
});
