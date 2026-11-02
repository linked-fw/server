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
 * The syncs follow the storage routing (core's `syncTargets`); {@link syncTargetsLine} names the
 * datasets they write into when that is more than the default dataset.
 */
import {
  GRAPH_TARGET_ENV,
  graphTargetOptionsFromEnv,
  setGraphTargets,
  type GraphTargets,
} from '@_linked/core/utils/graphTargets';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import type { GraphSyncTargets } from '@_linked/core/shapes/syncTargets';
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

/** The variable that says who writes the app's shape and ontology graphs. */
export const GRAPH_WRITER_ENV = 'LINKED_GRAPH_WRITER';

/**
 * Who writes the app's shape and ontology graphs: `'app'` (the default) the app itself, at boot;
 * `'host'` a host that runs it (Create Now), which reads the
 * content through `POST /admin/graph-content` and writes it itself, so the app writes none.
 */
export type GraphWriter = 'app' | 'host';

/**
 * `LINKED_GRAPH_WRITER` from `env`: unset or empty is `'app'`; any value other than `app` or
 * `host` throws, naming the variable (the boot stops on it).
 */
export function graphWriterFromEnv(env: Record<string, string | undefined>): GraphWriter {
  const value = env[GRAPH_WRITER_ENV]?.trim();
  if (!value || value === 'app') return 'app';
  if (value === 'host') return 'host';
  throw new Error(
    `${GRAPH_WRITER_ENV} must be 'app' or 'host' (who writes the app's shape and ontology graphs), not ${JSON.stringify(value)}`,
  );
}

/**
 * Whether this process writes its shape and ontology graphs: the one check every write path of the
 * syncs goes through (the boot's ontology and shape syncs). False
 * under `LINKED_GRAPH_WRITER=host`.
 */
export function appWritesGraphs(env: Record<string, string | undefined> = process.env): boolean {
  return graphWriterFromEnv(env) === 'app';
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

/** Which boot syncs run: only the graphs a running sync writes are named. */
export interface BootSyncs {
  /** The shape sync runs (`shapeSyncOn`): it writes the shape graphs and the app's shape graph. */
  shapeSync: boolean;
  /** The ontology sync runs (the same switch as the shape sync): it writes the ontology graphs. */
  ontologySync: boolean;
}

/**
 * One log line naming the datasets the boot syncs that run write into, per graph kind, when the
 * routing sends any graph beyond the default dataset (core's `graphSyncTargets`: a package's
 * shape graph goes wherever its shapes or the shape shapes route, its ontology graph also
 * wherever shapes using its classes or the term shapes route, the app's graph wherever shapes
 * declaring `contains`, or their sub-shapes, route). Undefined when every graph goes to the default dataset only (the
 * syncs' own lines say enough), when no sync runs or without a default dataset. `core` is
 * `@_linked/core/shapes/syncTargets` (server only, imported when the boot runs). Reads the
 * registered shapes outside any shape catalog (run it at boot, never inside `withShapeCatalog`).
 */
export function syncTargetsLine(
  syncs: BootSyncs,
  core: {
    graphSyncTargets: () => GraphSyncTargets;
    datasetLabel: (dataset: IDataset) => string;
  },
): string | undefined {
  const defaultDataset = LinkedStorage.getDefaultDataset();
  if (!defaultDataset || (!syncs.shapeSync && !syncs.ontologySync)) return undefined;
  const { datasetLabel } = core;
  const targets = core.graphSyncTargets();
  const beyondDefault = (lists: Iterable<IDataset[]>) =>
    [...lists].some((list) => list.some((ds) => ds !== defaultDataset));
  const kinds: string[] = [];
  const perDataset = (byPackage: Map<string, IDataset[]>): string => {
    const all = [...byPackage.keys()];
    return targets.datasets
      .map((ds) => {
        const names = all.filter((name) => byPackage.get(name)?.includes(ds)).sort();
        if (!names.length) return undefined;
        return `${datasetLabel(ds)} (${names.length === all.length ? 'every package' : names.join(', ')})`;
      })
      .filter((part): part is string => !!part)
      .join(', ');
  };
  let routed = false;
  if (syncs.shapeSync) {
    routed ||= beyondDefault(targets.shapes.values()) || beyondDefault([targets.appShapes]);
    kinds.push(`shape graphs → ${perDataset(targets.shapes)}`);
    kinds.push(`app shape graph → ${targets.appShapes.map(datasetLabel).join(', ')}`);
  }
  if (syncs.ontologySync) {
    routed ||= beyondDefault(targets.ontologies.values());
    kinds.push(`ontology graphs → ${perDataset(targets.ontologies)}`);
  }
  if (!routed) return undefined;
  return `[LinkedServer] The boot syncs follow the routing: ${kinds.join('; ')}.`;
}
