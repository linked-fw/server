/**
 * The graph routes the process runs with, as core's routing holds them once the app's storage
 * file has run (`LinkedStorage.setDatasetForShapes(dataset, shapes, {graph})`, or `loadStores`
 * for a datasets config that still carries routes). Answered by `GET /admin/routes`, so a host
 * can compare what it wrote into the storage file with what actually runs.
 */
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { getShapeGraphs, graphRoutingFor } from '@_linked/core/utils/graphRouting';
import { getAllShapeClasses } from '@_linked/core/utils/ShapeClass';
import { graphs } from '@_linked/core/ontologies/graphs';
import type { IDataset } from '@_linked/core/interfaces/IDataset';
import { getGraphTargets, type GraphTargets } from '@_linked/core/utils/graphTargets';
import { graphTargetEnv, graphWriterFromEnv, type GraphWriter } from './graphTargets.js';

/** One dataset the router knows, and its graph routes. */
export interface DatasetRoutes {
  /**
   * The store's class name (`FusekiStore`, `RemoteDataset`, …). The server never sees the
   * aliases of the storage config, so a dataset is told apart by this, `default` and `id`.
   */
  store: string;
  /** The store's `id`, when it has one (a named `RemoteDataset` does). */
  id?: string;
  /** Whether this is the default dataset (the one for every shape without a pin). */
  default: boolean;
  /** The dataset's routes as registered: shape IRI → graph IRI. */
  routes: Record<string, string>;
  /**
   * The registered shapes that resolve to this dataset and whose instances are written to its
   * default graph: no route of their own and no routed super-shape. Sorted.
   */
  defaultGraphShapes: string[];
}

/** The body of `GET /admin/routes`. */
export interface EffectiveRoutes {
  /** Every dataset the router knows, the default one first, then in the order they were pinned. */
  datasets: DatasetRoutes[];
  /**
   * The process's graph targets (core's `getGraphTargets()`: `'package'`, `'default'` or a shared
   * graph IRI each), one global setting for every dataset: where the boot syncs write and where
   * `graphs.allOntologies` / `graphs.allShapes` read.
   */
  graphTargets: GraphTargets;
  /**
   * `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH` as the process has them (unset ones left out),
   * so a host can tell where {@link graphTargets} came from.
   */
  graphTargetEnv: Record<string, string>;
  /**
   * Who writes the app's shape and ontology graphs (`LINKED_GRAPH_WRITER`): `'app'`, or `'host'`
   * when a host writes them and the process writes none.
   */
  graphWriter: GraphWriter;
}

/** The routes of every dataset the router knows (see {@link EffectiveRoutes}). */
export function effectiveGraphRoutes(env: Record<string, string | undefined> = process.env): EffectiveRoutes {
  const datasets = [...LinkedStorage.getDatasets()];
  const defaultDataset = LinkedStorage.getDefaultDataset();
  const defaultGraphShapes = new Map<IDataset, string[]>(datasets.map((ds) => [ds, []]));
  for (const [iri, shapeClass] of getAllShapeClasses()) {
    const dataset = LinkedStorage.getDatasetForShapeClass(shapeClass);
    const list = dataset && defaultGraphShapes.get(dataset);
    if (!list) continue;
    const graph = graphRoutingFor(dataset)?.graphForShape(iri) ?? graphs.default;
    if (graph === graphs.default) list.push(iri);
  }
  return {
    datasets: datasets.map((dataset) => {
      const id = (dataset as { id?: unknown }).id;
      return {
        store: dataset?.constructor?.name || 'unknown',
        ...(typeof id === 'string' && id ? { id } : {}),
        default: dataset === defaultDataset,
        routes: getShapeGraphs(dataset),
        defaultGraphShapes: (defaultGraphShapes.get(dataset) ?? []).sort(),
      };
    }),
    graphTargets: getGraphTargets(),
    graphTargetEnv: graphTargetEnv(env),
    graphWriter: graphWriterFromEnv(env),
  };
}
