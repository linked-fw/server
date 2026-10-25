/**
 * Where the boot syncs keep the registered packages' ontology data and shapes: core's graph
 * targets (`ontologyGraph`, `shapeGraph`; `@_linked/core/utils/graphTargets`), one global setting
 * of the process. `LINKED_ONTOLOGY_GRAPH` and `LINKED_SHAPE_GRAPH` each take `'package'` (the
 * default, one graph per package), `'default'` (the default graph) or the absolute IRI of one
 * shared graph.
 *
 * The server reads them once at boot, checks them (an invalid value stops the boot, naming the
 * variable) and calls core's `setGraphTargets` before the stores are initialised and before the
 * syncs. No store takes a setting of its own, and the frontend needs none: its
 * `.from(graphs.allOntologies)` reaches the backend as the portable name, and the backend's
 * store expands it under this setting.
 *
 * The syncs write into the default dataset only. {@link syncPinWarning} names the shapes whose
 * routing sends their reads elsewhere, when the boot runs those syncs.
 */
import {
  GRAPH_TARGET_ENV,
  graphTargetOptionsFromEnv,
  setGraphTargets,
  type GraphTargets,
} from '@_linked/core/utils/graphTargets';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { getAllShapeClasses } from '@_linked/core/utils/ShapeClass';
import type { IDataset } from '@_linked/core/interfaces/IDataset';

/**
 * Read `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH` from `env` (checked: an invalid value throws,
 * naming the variable) and set them as the process's graph targets (core's `setGraphTargets`;
 * unset ones are `'package'`). Returns the settings the env gave.
 */
export function applyGraphTargetsFromEnv(env: Record<string, string | undefined>): Partial<GraphTargets> {
  const fromEnv = graphTargetOptionsFromEnv(env);
  setGraphTargets(fromEnv);
  return fromEnv;
}

/** The env variables as set (unset and empty ones left out), for `GET /admin/routes`. */
export function graphTargetEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [GRAPH_TARGET_ENV.ontologyGraph, GRAPH_TARGET_ENV.shapeGraph]) {
    const value = env[name];
    if (value) out[name] = value;
  }
  return out;
}

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

/** The classes of the shape shapes: what the shape sync writes. */
export const SHAPE_SHAPE_CLASSES: readonly string[] = [`${SH}NodeShape`, `${SH}PropertyShape`];

/**
 * The classes of the ontology term shapes (the class and property shapes core, `@_linked/rdfs`
 * and `@_linked/owl` register): what the ontology sync writes and the hierarchy reads.
 */
export const ONTOLOGY_TERM_CLASSES: readonly string[] = [
  `${RDFS}Class`,
  `${OWL}Class`,
  `${RDF}Property`,
  `${OWL}ObjectProperty`,
  `${OWL}DatatypeProperty`,
  `${OWL}AnnotationProperty`,
];

/**
 * A dataset as a log line tells it apart: its store class, and its `id` when it has one, else the
 * dataset name a SPARQL store keeps from its endpoint (`FusekiStore`'s `dataset`).
 */
function datasetName(dataset: IDataset): string {
  const { id, dataset: name } = dataset as { id?: unknown; dataset?: unknown };
  const store = dataset?.constructor?.name || 'unknown';
  const label = typeof id === 'string' && id ? id : typeof name === 'string' && name ? name : undefined;
  return label ? `${store} "${label}"` : store;
}

/**
 * The watched class `shapeClass` or one of its super-shapes targets (a sub-shape of `owl:Class`,
 * say `owl:Restriction`, goes where its parent is pinned), else undefined.
 */
function watchedClassOf(shapeClass: Function, watched: ReadonlySet<string>): string | undefined {
  for (let current: unknown = shapeClass; typeof current === 'function' && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    const id = (current as { targetClass?: { id?: unknown } }).targetClass?.id;
    if (typeof id === 'string' && watched.has(id)) return id;
  }
  return undefined;
}

/** Which boot syncs run: only the shapes a running sync writes are worth a warning. */
export interface BootSyncs {
  /** The shape sync runs (`shapeSyncOn`): it writes the shape shapes. */
  shapeSync: boolean;
  /** The ontology sync runs (`bootSyncsOntologies`): it writes the ontology term shapes. */
  ontologySync: boolean;
}

/**
 * One warning when routing pins a shape a boot sync that runs writes (the shape shapes
 * `NodeShape` / `PropertyShape` for the shape sync, an ontology term shape such as `rdfs:Class` /
 * `owl:ObjectProperty` for the ontology sync) to a dataset other than the default one: the syncs
 * write into the default dataset only, so reads of those shapes on the pinned dataset miss what
 * they wrote. Names each such shape (sub-shapes of a watched shape included) and its dataset.
 * Undefined when there is nothing to warn about (no sync runs, or no default dataset). Reads the
 * registered shapes outside any shape catalog (run it at boot, never inside `withShapeCatalog`).
 */
export function syncPinWarning(syncs: BootSyncs): string | undefined {
  const defaultDataset = LinkedStorage.getDefaultDataset();
  if (!defaultDataset) return undefined;
  const watched = new Set([
    ...(syncs.shapeSync ? SHAPE_SHAPE_CLASSES : []),
    ...(syncs.ontologySync ? ONTOLOGY_TERM_CLASSES : []),
  ]);
  if (watched.size === 0) return undefined;
  const pinned = new Map<IDataset, string[]>();
  for (const [iri, shapeClass] of getAllShapeClasses()) {
    const targetClass = watchedClassOf(shapeClass, watched);
    if (!targetClass) continue;
    const dataset = LinkedStorage.getDatasetForShapeClass(shapeClass);
    if (!dataset || dataset === defaultDataset) continue;
    const list = pinned.get(dataset) ?? [];
    list.push(`${shapeClass.name || iri} (${targetClass})`);
    pinned.set(dataset, list);
  }
  if (pinned.size === 0) return undefined;
  const parts = [...pinned].map(([dataset, shapes]) => `${shapes.sort().join(', ')} → ${datasetName(dataset)}`);
  const writers =
    syncs.ontologySync && syncs.shapeSync ? 'ontology and shape syncs write' : `${syncs.shapeSync ? 'shape' : 'ontology'} sync writes`;
  return (
    `[LinkedServer] Routing pins shapes the boot syncs write to a dataset other than the default ` +
    `one: ${parts.join('; ')}. The ${writers} into the default dataset (${datasetName(defaultDataset)}) ` +
    `only, so reads of these shapes on the pinned dataset do not see what the boot wrote.`
  );
}
