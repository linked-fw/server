import { describe, expect, it } from '@jest/globals';

// The graph targets from the environment: LINKED_ONTOLOGY_GRAPH / LINKED_SHAPE_GRAPH, checked and
// filled into every store that takes them (for what its own options leave unset); a store that
// takes none runs 'package' with a warning; `GET /admin/routes` reports both.

process.env.SITE_ROOT ??= 'http://app.test:4000';
const { applyGraphTargetsFromEnv, graphTargetEnv } = await import('../utils/graphTargets.js');
const { SparqlDataset } = await import('@_linked/core/sparql/SparqlDataset');
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
const { effectiveGraphRoutes } = await import('../utils/effectiveRoutes.js');

const SHARED = 'https://data.example.org/graph/ontology';

class Store extends (SparqlDataset as any) {
  async executeSparqlSelect() {
    return { head: { vars: [] }, results: { bindings: [] } };
  }
  async executeSparqlUpdate() {}
}
class NoTargets {}

describe('applyGraphTargetsFromEnv', () => {
  it('fills what each store leaves unset, and keeps what it set itself', () => {
    const plain = new Store() as any;
    const own = new (Store as any)({ shapeGraph: "default" });
    const given = applyGraphTargetsFromEnv(
      { LINKED_ONTOLOGY_GRAPH: SHARED, LINKED_SHAPE_GRAPH: 'package' },
      [plain, own],
      () => {},
    );
    expect(given).toEqual({ ontologyGraph: SHARED, shapeGraph: 'package' });
    expect(plain.graphTargets()).toEqual({ ontologyGraph: SHARED, shapeGraph: 'package' });
    expect(own.graphTargets()).toEqual({ ontologyGraph: SHARED, shapeGraph: 'default' });
  });

  it('changes nothing without the variables', () => {
    const store = new Store() as any;
    expect(applyGraphTargetsFromEnv({ LINKED_ONTOLOGY_GRAPH: '' }, [store])).toEqual({});
    expect(store.graphTargets()).toEqual({ ontologyGraph: 'package', shapeGraph: 'package' });
  });

  it('refuses an invalid value, naming the variable', () => {
    expect(() => applyGraphTargetsFromEnv({ LINKED_SHAPE_GRAPH: 'shared' }, [])).toThrow(
      /^Invalid shapeGraph "shared" \(from env LINKED_SHAPE_GRAPH\)/,
    );
    expect(() => applyGraphTargetsFromEnv({ LINKED_ONTOLOGY_GRAPH: SHARED, LINKED_SHAPE_GRAPH: SHARED }, [])).toThrow(
      /both name/,
    );
  });

  it("warns once per store that takes no targets when the env sets another mode than 'package'", () => {
    const warnings: string[] = [];
    applyGraphTargetsFromEnv({ LINKED_ONTOLOGY_GRAPH: 'default' }, [new NoTargets(), new Store()], (m) => warnings.push(m));
    expect(warnings).toEqual([expect.stringContaining("NoTargets takes no graph targets, so it runs 'package'")]);
    const none: string[] = [];
    applyGraphTargetsFromEnv({ LINKED_ONTOLOGY_GRAPH: 'package' }, [new NoTargets()], (m) => none.push(m));
    expect(none).toEqual([]);
  });
});

describe('GET /admin/routes reports the graph targets', () => {
  it("lists each store's targets and the variables as set", () => {
    const store = new (Store as any)({ ontologyGraph: "default" });
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(store);
    const routes = effectiveGraphRoutes({ LINKED_SHAPE_GRAPH: SHARED, LINKED_ONTOLOGY_GRAPH: '' });
    expect(routes.datasets[0]).toMatchObject({ store: 'Store', default: true, ontologyGraph: 'default', shapeGraph: 'package' });
    expect(routes.graphTargetEnv).toEqual({ LINKED_SHAPE_GRAPH: SHARED });
    expect(graphTargetEnv({})).toEqual({});
    if (before) LinkedStorage.setDefaultDataset(before);
  });
});

describe('the boot', () => {
  it('fails fatally on an invalid variable, before any store is initialised, naming it', async () => {
    const { LinkedServer } = await import('../shapes/LinkedServer.js');
    const { isFatalError } = await import('../utils/fatalError.js');
    const saved = process.env.LINKED_ONTOLOGY_GRAPH;
    process.env.LINKED_ONTOLOGY_GRAPH = 'shared';
    let inits = 0;
    const store = new (Store as any)();
    store.init = async () => {
      inits++;
    };
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(store);
    try {
      inits = 0; // setDefaultDataset may init the store itself
      const error = await new LinkedServer({} as any).initStores().catch((e: unknown) => e);
      expect(isFatalError(error)).toBe(true);
      expect(String((error as Error).message)).toContain('Invalid ontologyGraph "shared" (from env LINKED_ONTOLOGY_GRAPH)');
      expect(inits).toBe(0);
      process.env.LINKED_ONTOLOGY_GRAPH = 'default';
      await new LinkedServer({} as any).initStores();
      expect(inits).toBe(1);
      expect(store.graphTargets().ontologyGraph).toBe('default');
    } finally {
      if (saved === undefined) delete process.env.LINKED_ONTOLOGY_GRAPH;
      else process.env.LINKED_ONTOLOGY_GRAPH = saved;
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });
});
