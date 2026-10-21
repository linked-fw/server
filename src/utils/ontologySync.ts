/**
 * Ontology sync and the shape check, as the server runs them before its shape sync: at boot and
 * when the host asks for a re-sync (`POST /admin/sync-shapes`).
 *
 * - The ontology sync (core `syncOntologies`) writes each registered package's
 *   `rdfs:subClassOf` triples into the app's default dataset, skipping a package whose stored
 *   hash matches, so the store's RDFS view infers the class hierarchy.
 * - The shape check (core `checkShapeHierarchy`) compares the registered shapes with that
 *   hierarchy. A running app is never stopped by it: its findings are logged and counted.
 * - The in-memory class hierarchy (core `loadOntologyHierarchy`, when the installed core has it)
 *   is loaded also when the sync is off; the sync loads it itself when it runs.
 * - Before either, every linked package directory the server discovered registers its ontologies
 *   (core `registerInstalledOntologies`, when the installed core has it): a package the app only
 *   deep-imports shape files from never evaluates its register modules, so its data would be
 *   missing from both.
 *
 * Both core modules are server only and not in core's index, so they are imported dynamically.
 * Kept apart from `LinkedServer` so the order and the failure handling can be tested without
 * booting a server.
 */
import type {BootOrphanScope} from './syncShapes.js';

/** The subset of core's ontology and shape-check API this module calls. */
export interface OntologyCore {
  syncOntologies(
    ds: unknown,
    options: {orphanScope: BootOrphanScope},
  ): Promise<{written: string[]; skipped: string[]; pruned: string[]}>;
  checkShapeHierarchy(options: {dependencies?: Record<string, string[]>}): Promise<
    Array<{kind: string; severity: 'error' | 'warning'; shape?: string; iri?: string; message: string}>
  >;
  /** Absent in a core without the in-memory class hierarchy. */
  loadOntologyHierarchy?: () => Promise<unknown>;
  /** Absent in a core that cannot register installed packages' ontologies. */
  registerInstalledOntologies?: (packageDirs: string[]) => Promise<string[]>;
}

/** What the ontology sync and the shape check did, as `POST /admin/sync-shapes` reports it. */
export interface OntologyPhaseResult {
  /** Packages whose hierarchy was written, and packages left as they were (unchanged or unreadable). */
  ontologies: {written: string[]; skipped: string[]};
  /** The shape check's findings, counted by severity. */
  shapeCheck: {errors: number; warnings: number};
  /** The first error the sync or the check threw; the phase went on without it. */
  failure?: Error;
}

/**
 * Whether the server syncs shapes (and so ontologies) into its app data: off when `linked.config`
 * sets `syncShapesOnBoot: false` or the environment sets `LINKED_SYNC_SHAPES_ON_BOOT=false`. One
 * switch for both syncs, at boot and on the host's request.
 */
export function shapeSyncOn(
  env: Record<string, string | undefined>,
  configFlag: unknown,
): boolean {
  return configFlag !== false && env.LINKED_SYNC_SHAPES_ON_BOOT !== 'false';
}

/**
 * Whether the boot syncs ontologies: when shape sync is on ({@link shapeSyncOn}) and the
 * environment does not opt out with `LINKED_SYNC_ONTOLOGIES_ON_BOOT=false`.
 */
export function bootSyncsOntologies(
  env: Record<string, string | undefined>,
  configFlag?: unknown,
): boolean {
  return shapeSyncOn(env, configFlag) && env.LINKED_SYNC_ONTOLOGIES_ON_BOOT !== 'false';
}

/**
 * Import core's ontology sync, shape check and (when present) hierarchy loader and installed
 * packages' registration.
 */
export async function loadOntologyCore(): Promise<OntologyCore> {
  const sync = await import('@_linked/core/ontology/syncOntologies');
  const check = await import('@_linked/core/shapes/checkShapeHierarchy');
  const hierarchy = await import('@_linked/core/ontology/hierarchy');
  const loadOntologyHierarchy = (hierarchy as {loadOntologyHierarchy?: () => Promise<unknown>})
    .loadOntologyHierarchy;
  let registerInstalledOntologies: OntologyCore['registerInstalledOntologies'];
  try {
    const registerInstalled = (await import('@_linked/core/ontology/registerInstalled')) as {
      registerInstalledOntologies?: OntologyCore['registerInstalledOntologies'];
    };
    if (typeof registerInstalled.registerInstalledOntologies === 'function') {
      registerInstalledOntologies = registerInstalled.registerInstalledOntologies;
    }
  } catch {
    // A core without the module: packages register only through the app's own imports.
  }
  return {
    syncOntologies: (ds, options) =>
      sync.syncOntologies(ds as Parameters<typeof sync.syncOntologies>[0], options),
    checkShapeHierarchy: (options) => check.checkShapeHierarchy(options),
    loadOntologyHierarchy:
      typeof loadOntologyHierarchy === 'function' ? loadOntologyHierarchy : undefined,
    registerInstalledOntologies,
  };
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
const list = (names: string[]) => (names.length ? names.join(', ') : 'none');

/**
 * Register the ontologies of the installed linked packages in `packageDirs` (package roots), sync
 * the registered ontologies into `ds` (when `sync` is set and there is a dataset), then run the
 * shape check. Never throws: a failed registration is logged and the phase goes on; a failed sync is logged and returned as `failure`, and the
 * check still runs; a failed check likewise. Logs one line for the sync, one summary line for
 * the check and one line per finding.
 */
export async function runOntologyPhase(
  ds: unknown,
  {
    core,
    sync,
    orphanScope,
    dependencies,
    packageDirs = [],
    log = console.log,
    warn = console.warn,
  }: {
    core: OntologyCore;
    sync: boolean;
    orphanScope: BootOrphanScope;
    dependencies?: Record<string, string[]>;
    /** Every linked package directory the server discovered (transitively). */
    packageDirs?: string[];
    log?: (message: string) => void;
    warn?: (message: string, err?: unknown) => void;
  },
): Promise<OntologyPhaseResult> {
  const result: OntologyPhaseResult = {
    ontologies: {written: [], skipped: []},
    shapeCheck: {errors: 0, warnings: 0},
  };

  if (core.registerInstalledOntologies && packageDirs.length) {
    try {
      await core.registerInstalledOntologies(packageDirs);
    } catch (err) {
      warn("[LinkedServer] registering the installed packages' ontologies failed:", err);
    }
  }

  let hierarchyLoaded = false;
  if (sync && ds) {
    try {
      const {written, skipped, pruned} = await core.syncOntologies(ds, {orphanScope});
      result.ontologies = {written, skipped};
      hierarchyLoaded = true;
      log(
        `[LinkedServer] ontology sync: written ${list(written)}; skipped ${list(skipped)}` +
          (orphanScope === 'all' ? `; pruned ${list(pruned)}` : ''),
      );
    } catch (err) {
      result.failure = asError(err);
      warn('[LinkedServer] ontology sync failed:', err);
    }
  }
  if (!hierarchyLoaded && core.loadOntologyHierarchy) {
    try {
      await core.loadOntologyHierarchy();
    } catch (err) {
      warn('[LinkedServer] loading the class hierarchy failed:', err);
    }
  }

  try {
    const findings = await core.checkShapeHierarchy({dependencies});
    const errors = findings.filter((f) => f.severity === 'error').length;
    result.shapeCheck = {errors, warnings: findings.length - errors};
    log(`[LinkedServer] shape check: ${errors} error(s), ${findings.length - errors} warning(s)`);
    for (const f of findings) warn(`[LinkedServer] shape check ${f.severity} (${f.kind}): ${f.message}`);
  } catch (err) {
    result.failure ??= asError(err);
    warn('[LinkedServer] shape check failed:', err);
  }
  return result;
}

/**
 * The host's re-sync: the ontology phase, then the shape sync, which runs also when the ontology
 * phase failed. The ontology phase's failure is then thrown, so the route answers with it, as
 * it does for a failed shape sync.
 */
export async function syncOntologiesThenShapes<T extends object>(
  ontologyPhase: () => Promise<OntologyPhaseResult>,
  shapeSync: () => Promise<T>,
): Promise<T & Pick<OntologyPhaseResult, 'ontologies' | 'shapeCheck'>> {
  const {ontologies, shapeCheck, failure} = await ontologyPhase();
  const shapes = await shapeSync();
  if (failure) throw failure;
  return {...shapes, ontologies, shapeCheck};
}
