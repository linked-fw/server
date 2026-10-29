import { afterEach, describe, expect, it } from '@jest/globals';

// The graph targets from the environment: LINKED_ONTOLOGY_GRAPH / LINKED_SHAPE_GRAPH, checked and
// set once as core's global setting (no store takes them); `GET /admin/routes` reports the setting
// and the variables; the boot names the datasets the syncs write into when routing sends graphs
// beyond the default dataset.

process.env.SITE_ROOT ??= 'http://app.test:4000';
const { applyGraphTargetsFromEnv, graphTargetEnv, syncTargetsLine } = await import('../utils/graphTargets.js');
const { SparqlDataset } = await import('@_linked/core/sparql/SparqlDataset');
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
const { getGraphTargets, setGraphTargets } = await import('@_linked/core/utils/graphTargets');
await import('@_linked/core');
const { NodeShape, PropertyShape } = await import('@_linked/core/shapes/SHACL');
const { effectiveGraphRoutes } = await import('../utils/effectiveRoutes.js');

const SHARED = 'https://data.example.org/graph/ontology';

class Store extends (SparqlDataset as any) {
  async executeSparqlSelect() {
    return { head: { vars: [] }, results: { bindings: [] } };
  }
  async executeSparqlUpdate() {}
}
class Other extends Store {}

afterEach(() => setGraphTargets({}));

describe('applyGraphTargetsFromEnv', () => {
  it("sets core's global setting from the variables; an unset one is 'package'", () => {
    const given = applyGraphTargetsFromEnv({ LINKED_ONTOLOGY_GRAPH: SHARED, LINKED_SHAPE_GRAPH: '' });
    expect(given).toEqual({ ontologyGraph: SHARED });
    expect(getGraphTargets()).toEqual({ ontologyGraph: SHARED, shapeGraph: 'package' });
    applyGraphTargetsFromEnv({});
    expect(getGraphTargets()).toEqual({ ontologyGraph: 'package', shapeGraph: 'package' });
  });

  it('refuses an invalid value, naming the variable, and leaves the setting', () => {
    applyGraphTargetsFromEnv({ LINKED_SHAPE_GRAPH: 'default' });
    expect(() => applyGraphTargetsFromEnv({ LINKED_SHAPE_GRAPH: 'shared' })).toThrow(
      /^Invalid shapeGraph "shared" \(from env LINKED_SHAPE_GRAPH\)/,
    );
    expect(() => applyGraphTargetsFromEnv({ LINKED_ONTOLOGY_GRAPH: SHARED, LINKED_SHAPE_GRAPH: SHARED })).toThrow(
      /both name/,
    );
    expect(getGraphTargets().shapeGraph).toBe('default');
  });
});

describe('GET /admin/routes reports the graph targets', () => {
  it('reports the global setting once, and the variables as set', () => {
    const store = new (Store as any)();
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(store);
    try {
      setGraphTargets({ ontologyGraph: 'default' });
      const routes = effectiveGraphRoutes({ LINKED_SHAPE_GRAPH: SHARED, LINKED_ONTOLOGY_GRAPH: '' });
      expect(routes.graphTargets).toEqual({ ontologyGraph: 'default', shapeGraph: 'package' });
      expect(routes.datasets[0]).toMatchObject({ store: 'Store', default: true });
      expect(routes.datasets[0]).not.toHaveProperty('ontologyGraph');
      expect(routes.graphTargetEnv).toEqual({ LINKED_SHAPE_GRAPH: SHARED });
      expect(graphTargetEnv({})).toEqual({});
    } finally {
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });
});

const BOTH = { shapeSync: true, ontologySync: true };
const targetsCore = await import('@_linked/core/shapes/syncTargets');
const line = (syncs: { shapeSync: boolean; ontologySync: boolean }) => syncTargetsLine(syncs, targetsCore);

// An ontology package with data, so the ontology graphs have a package to place.
const { linkedPackage } = await import('@_linked/core/utils/Package');
const { createNameSpace } = await import('@_linked/core/utils/NameSpace');
linkedPackage('gt-onto').linkedOntology({}, createNameSpace('https://example.org/gt-onto/'), 'gt-onto', async () => [''], '../data/gt-onto.ttl');

describe('the sync targets line', () => {
  it('names the datasets when the shape shapes are pinned elsewhere, and is silent without a pin', () => {
    const appData = new (Store as any)();
    const shapes = new (Other as any)();
    shapes.id = 'shapes';
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(appData);
    try {
      expect(line(BOTH)).toBeUndefined();
      LinkedStorage.setDatasetForShapes(shapes, NodeShape, PropertyShape);
      const said = line(BOTH)!;
      expect(said).toContain('[LinkedServer] The boot syncs follow the routing: ');
      expect(said).toContain('shape graphs → Store (every package), Other "shapes" (every package)');
      expect(said).toContain('app shape graph → Store, Other "shapes"');
      expect(said).toContain('ontology graphs → Store (every package)');
    } finally {
      LinkedStorage.unsetDatasetForShape?.(NodeShape);
      LinkedStorage.unsetDatasetForShape?.(PropertyShape);
      if (before) LinkedStorage.setDefaultDataset(before);
    }
    expect(line(BOTH)).toBeUndefined();
  });

  it('names only the graphs of the syncs the boot runs', () => {
    const appData = new (Store as any)();
    const shapes = new (Other as any)();
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(appData);
    try {
      LinkedStorage.setDatasetForShapes(shapes, NodeShape, PropertyShape);
      expect(line({ shapeSync: false, ontologySync: false })).toBeUndefined();
      // the ontology sync alone names no shape graph; core's ontology follows core's own shapes
      // (NodeShape, PropertyShape) to their dataset
      expect(line({ shapeSync: false, ontologySync: true })).toBe(
        '[LinkedServer] The boot syncs follow the routing: ontology graphs → Store (every package), Other (@_linked/core).',
      );
      const said = line({ shapeSync: true, ontologySync: false })!;
      expect(said).toContain('shape graphs → Store (every package), Other (every package)');
      expect(said).not.toContain('ontology graphs');
    } finally {
      LinkedStorage.unsetDatasetForShape?.(NodeShape);
      LinkedStorage.unsetDatasetForShape?.(PropertyShape);
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });

  it('names a store without an id by the dataset of its endpoint', () => {
    const appData = new (Store as any)();
    const shapes = new (Other as any)();
    shapes.dataset = 'cn-main';
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(appData);
    try {
      LinkedStorage.setDatasetForShapes(shapes, NodeShape);
      expect(line(BOTH)).toContain('Other "cn-main" (every package)');
    } finally {
      LinkedStorage.unsetDatasetForShape?.(NodeShape);
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });

  it('an ontology term shape pinned (its sub-shapes through the parent): the ontology graphs go there too', async () => {
    const { Shape } = await import('@_linked/core/shapes/Shape');
    const { linkedShape } = await import('@_linked/core/package');
    class TermClass extends (Shape as any) {
      static targetClass = { id: 'http://www.w3.org/2002/07/owl#Class' };
    }
    class TermClassView extends TermClass {}
    (linkedShape as any)(TermClass);
    (linkedShape as any)(TermClassView);
    const appData = new (Store as any)();
    const ontology = new (Other as any)();
    ontology.id = 'ontology';
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(appData);
    try {
      LinkedStorage.setDatasetForShapes(ontology, TermClass as any);
      const said = line(BOTH)!;
      // The only term shape is pinned: every ontology graph goes there; core's also stays with
      // core's own shapes in the default dataset.
      expect(said).toContain('ontology graphs → Store (@_linked/core), Other "ontology" (every package)');
      expect(line({ shapeSync: true, ontologySync: false })).toBeUndefined();
    } finally {
      LinkedStorage.unsetDatasetForShape(TermClass as any);
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });
});

describe('the sync targets line and a sub-shape with its own target class', () => {
  it('leaves out a sub-shape of a watched shape that targets a class of its own', async () => {
    const { linkedShape } = await import('@_linked/core/package');
    class CatalogNodeShape extends (NodeShape as any) {
      static targetClass = { id: 'https://example.org/CatalogNodeShape' };
    }
    (linkedShape as any)(CatalogNodeShape);
    const appData = new (Store as any)();
    const catalog = new (Other as any)();
    catalog.id = 'catalog';
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(appData);
    try {
      LinkedStorage.setDatasetForShapes(catalog, CatalogNodeShape as any);
      expect(line(BOTH)).toBeUndefined();
    } finally {
      LinkedStorage.unsetDatasetForShape(CatalogNodeShape as any);
      if (before) LinkedStorage.setDefaultDataset(before);
    }
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
      expect(getGraphTargets().ontologyGraph).toBe('default');
    } finally {
      if (saved === undefined) delete process.env.LINKED_ONTOLOGY_GRAPH;
      else process.env.LINKED_ONTOLOGY_GRAPH = saved;
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });
});
