import { afterEach, describe, expect, it } from '@jest/globals';

// The graph targets from the environment: LINKED_ONTOLOGY_GRAPH / LINKED_SHAPE_GRAPH, checked and
// set once as core's global setting (no store takes them); `GET /admin/routes` reports the setting
// and the variables; the boot warns when routing pins the shapes the syncs write elsewhere.

process.env.SITE_ROOT ??= 'http://app.test:4000';
const { applyGraphTargetsFromEnv, graphTargetEnv, syncPinWarning } = await import('../utils/graphTargets.js');
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

describe('the sync pin warning', () => {
  it('names the shape shapes pinned to another dataset, and is silent without such a pin', () => {
    const appData = new (Store as any)();
    const shapes = new (Other as any)();
    shapes.id = 'shapes';
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(appData);
    try {
      expect(syncPinWarning(BOTH)).toBeUndefined();
      LinkedStorage.setDatasetForShapes(shapes, NodeShape, PropertyShape);
      const warning = syncPinWarning(BOTH);
      expect(warning).toContain('NodeShape (http://www.w3.org/ns/shacl#NodeShape)');
      expect(warning).toContain('PropertyShape (http://www.w3.org/ns/shacl#PropertyShape)');
      expect(warning).toContain('→ Other "shapes"');
      expect(warning).toContain('write into the default dataset (Store) only');
    } finally {
      LinkedStorage.unsetDatasetForShape?.(NodeShape);
      LinkedStorage.unsetDatasetForShape?.(PropertyShape);
      if (before) LinkedStorage.setDefaultDataset(before);
    }
    expect(syncPinWarning(BOTH)).toBeUndefined();
  });

  it('is silent for the shapes of a sync the boot does not run', () => {
    const appData = new (Store as any)();
    const shapes = new (Other as any)();
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(appData);
    try {
      LinkedStorage.setDatasetForShapes(shapes, NodeShape, PropertyShape);
      expect(syncPinWarning({ shapeSync: false, ontologySync: false })).toBeUndefined();
      // the ontology sync alone does not write the shape shapes
      expect(syncPinWarning({ shapeSync: false, ontologySync: true })).toBeUndefined();
      const warning = syncPinWarning({ shapeSync: true, ontologySync: false });
      expect(warning).toContain('NodeShape (http://www.w3.org/ns/shacl#NodeShape)');
      expect(warning).toContain('The shape sync writes into the default dataset (Store) only');
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
      expect(syncPinWarning(BOTH)).toContain('→ Other "cn-main"');
    } finally {
      LinkedStorage.unsetDatasetForShape?.(NodeShape);
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });

  it('names an ontology term shape and its sub-shapes, pinned through the parent, each under its own class', async () => {
    const { Shape } = await import('@_linked/core/shapes/Shape');
    const { linkedShape } = await import('@_linked/core/package');
    class TermClass extends (Shape as any) {
      static targetClass = { id: 'http://www.w3.org/2002/07/owl#Class' };
    }
    class TermRestriction extends TermClass {
      static targetClass = { id: 'http://www.w3.org/2002/07/owl#Restriction' };
    }
    class TermClassView extends TermClass {}
    (linkedShape as any)(TermClass);
    (linkedShape as any)(TermRestriction);
    (linkedShape as any)(TermClassView);
    const appData = new (Store as any)();
    const ontology = new (Other as any)();
    const before = LinkedStorage.getDefaultDataset();
    LinkedStorage.setDefaultDataset(appData);
    try {
      LinkedStorage.setDatasetForShapes(ontology, TermClass as any);
      const warning = syncPinWarning(BOTH);
      expect(warning).toContain('TermClass (http://www.w3.org/2002/07/owl#Class)');
      expect(warning).toContain('TermRestriction (http://www.w3.org/2002/07/owl#Restriction)');
      expect(warning).toContain('TermClassView (http://www.w3.org/2002/07/owl#Class)');
      expect(warning).toContain('→ Other');
    } finally {
      LinkedStorage.unsetDatasetForShape(TermClass as any);
      if (before) LinkedStorage.setDefaultDataset(before);
    }
  });
});

describe('the sync pin warning and a sub-shape with its own target class', () => {
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
      expect(syncPinWarning(BOTH)).toBeUndefined();
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
