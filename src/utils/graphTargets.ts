/**
 * Where the stores keep the registered packages' ontology data and shapes: core's graph targets
 * (`ontologyGraph`, `shapeGraph`; `@_linked/core/utils/graphTargets`), filled from the environment
 * at boot. `LINKED_ONTOLOGY_GRAPH` and `LINKED_SHAPE_GRAPH` each take `'package'` (the default, one
 * graph per package), `'default'` (the default graph) or the absolute IRI of one shared graph.
 *
 * The server reads them, checks them (an invalid value stops the boot, naming the variable), and
 * sets them on every store registered in `LinkedStorage` at boot that takes graph targets, for
 * what the store's own options leave unset. A store that takes none (`RemoteDataset`) runs `'package'`.
 */
import {
  GRAPH_TARGET_ENV,
  graphTargetOptionsFromEnv,
  type GraphTargets,
} from '@_linked/core/utils/graphTargets';

/** A store as this module sees it: one that may take graph targets. */
type TargetStore = {
  setGraphTargets?: (options: Partial<GraphTargets>, how?: {onlyUnset?: boolean}) => void;
  constructor?: {name?: string};
};

/**
 * Read `LINKED_ONTOLOGY_GRAPH` / `LINKED_SHAPE_GRAPH` from `env` (checked: an invalid value throws,
 * naming the variable) and fill every store in `stores` that takes graph targets with them, where
 * its own options leave a setting unset. A store that takes none gets one warning when the env sets
 * a mode other than `'package'` (it runs `'package'`). Returns the settings the env gave.
 */
export function applyGraphTargetsFromEnv(
  env: Record<string, string | undefined>,
  stores: Iterable<unknown>,
  warn: (message: string) => void = console.warn,
): Partial<GraphTargets> {
  const fromEnv = graphTargetOptionsFromEnv(env);
  if (Object.keys(fromEnv).length === 0) return fromEnv;
  const nonDefault = Object.values(fromEnv).some((value) => value !== 'package');
  for (const store of stores) {
    const target = store as TargetStore | null | undefined;
    if (typeof target?.setGraphTargets === 'function') {
      try {
        target.setGraphTargets(fromEnv, {onlyUnset: true});
      } catch (error) {
        throw new Error(
          `${GRAPH_TARGET_ENV.ontologyGraph} / ${GRAPH_TARGET_ENV.shapeGraph} do not fit ` +
            `${target.constructor?.name ?? 'a store'}'s own graph targets: ${(error as Error)?.message ?? error}`,
        );
      }
    } else if (nonDefault) {
      warn(
        `[LinkedServer] ${target?.constructor?.name ?? 'a store'} takes no graph targets, so it runs ` +
          `'package' for the ontology and shape graphs whatever ${GRAPH_TARGET_ENV.ontologyGraph} / ` +
          `${GRAPH_TARGET_ENV.shapeGraph} set.`,
      );
    }
  }
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
