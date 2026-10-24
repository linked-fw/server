/**
 * Ontology sync and the shape check, as the server runs them before its shape sync: at boot and
 * when the host asks for a re-sync (`POST /admin/sync-shapes`).
 *
 * - The ontology sync (core `syncOntologies`) writes each registered package's ontology data into
 *   its own named graph of the app's default dataset (`{package IRI}/graph/ontology`, with a
 *   record in the graph registry that marks it as a hierarchy source), skipping a package whose
 *   stored hash matches, so the store's RDFS view infers the class hierarchy. A store without
 *   graph queries (it answers `unsupported-query-kind`, or has no `graphQuery`) gets core's
 *   earlier sync of the `rdfs:subClassOf` triples into the default graph instead. The graphs the
 *   sync wrote or dropped are observed on core's query dispatch and reported by name.
 * - The shape check (core `checkShapeHierarchy`) compares the registered shapes with that
 *   hierarchy. A running app is never stopped by it: its findings are logged and counted.
 * - The in-memory class hierarchy (core `loadOntologyHierarchy`) is loaded also when the sync
 *   is off; the sync loads it itself when it runs.
 * - Before either, every linked package directory the server discovered registers its ontologies
 *   (core `registerInstalledOntologies`): a package the app only deep-imports shape files from
 *   never evaluates its register modules, so its data would be missing from both. A source
 *   package without built register modules (a workspace package in dev) registers through
 *   `importModule` (Vite's `ssrLoadModule`), when the caller passes one.
 *
 * The four core modules (`ontology/syncOntologies`, `shapes/checkShapeHierarchy`,
 * `ontology/hierarchy`, `ontology/registerInstalled`) are server only and not in core's index, so
 * {@link loadOntologyCore} imports them by their fixed subpaths when the phase runs; the core
 * this server depends on has all of them. Kept apart from `LinkedServer` so the order and the failure handling can be tested without
 * booting a server.
 */
import type {BootOrphanScope} from './syncShapes.js';

/** The subset of core's ontology and shape-check API this module calls. */
export interface OntologyCore {
  syncOntologies(
    ds: unknown,
    options: {orphanScope: BootOrphanScope},
  ): Promise<{written: string[]; skipped: string[]; pruned: string[]; target?: string; fallback?: true}>;
  checkShapeHierarchy(options: {dependencies?: Record<string, string[]>}): Promise<
    Array<{kind: string; severity: 'error' | 'warning'; shape?: string; iri?: string; message: string}>
  >;
  /** Loads the in-memory class hierarchy. Optional so a test double can leave it out. */
  loadOntologyHierarchy?: () => Promise<unknown>;
  /**
   * Calls `onGraph` for every graph query on `ds` that succeeds until the returned function is
   * called (core's `subscribeQueryDispatch`). Optional so a test double can leave it out.
   */
  observeGraphQueries?: (
    ds: unknown,
    onGraph: (query: {kind: string; graph: string}, settled: Promise<unknown>) => void,
  ) => () => void;
  /**
   * Registers the ontologies of the installed packages in the given directories. Optional so a
   * test double can leave it out.
   */
  registerInstalledOntologies?: (
    packageDirs: string[],
    options?: {importModule?: (file: string) => Promise<unknown>},
  ) => Promise<string[]>;
}

/** What the ontology sync and the shape check did, as `POST /admin/sync-shapes` reports it. */
export interface OntologyPhaseResult {
  /**
   * Packages whose ontology graph (or, on a store without graph queries, hierarchy) was written,
   * packages left as they were (unchanged or unreadable), and the graphs the sync wrote and
   * dropped (empty on a store without graph queries).
   */
  ontologies: {written: string[]; skipped: string[]; graphs?: string[]; droppedGraphs?: string[]};
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
 * Import core's ontology sync, shape check, hierarchy loader and installed packages'
 * registration.
 */
export async function loadOntologyCore(): Promise<OntologyCore> {
  const sync = await import('@_linked/core/ontology/syncOntologies');
  const check = await import('@_linked/core/shapes/checkShapeHierarchy');
  const hierarchy = await import('@_linked/core/ontology/hierarchy');
  const registerInstalled = await import('@_linked/core/ontology/registerInstalled');
  const dispatch = await import('@_linked/core/queries/queryDispatch');
  return {
    syncOntologies: (ds, options) =>
      sync.syncOntologies(ds as Parameters<typeof sync.syncOntologies>[0], options),
    checkShapeHierarchy: (options) => check.checkShapeHierarchy(options),
    loadOntologyHierarchy: () => hierarchy.loadOntologyHierarchy(),
    registerInstalledOntologies: (packageDirs, options) =>
      registerInstalled.registerInstalledOntologies(packageDirs, options),
    observeGraphQueries: (ds, onGraph) =>
      dispatch.subscribeQueryDispatch((event) => {
        if (event.kind === 'graph' && event.target === ds) onGraph(event.query, event.result);
      }),
  };
}

/**
 * The package directories whose ontologies register before the sync: every linked package
 * discovered in the app's dependency tree, then the app's own workspace packages (an ontology
 * package in `packages/` that no package imports is one, so the dependency walk never reaches it).
 * Order kept, duplicates dropped.
 */
export function ontologyPackageDirs(
  linkedPackageDirs: Iterable<string>,
  workspacePackageDirs: Iterable<string>,
): string[] {
  return [...new Set([...linkedPackageDirs, ...workspacePackageDirs])];
}

/**
 * In dev, the loader for source register modules: Vite's `ssrLoadModule`, so a workspace package
 * that was never built registers on the core the SSR graph uses. Undefined without Vite (a built
 * app), where source packages are skipped.
 */
export function sourceModuleImporter(
  vite: {ssrLoadModule?: (url: string) => Promise<unknown>} | undefined | null,
): ((file: string) => Promise<unknown>) | undefined {
  const ssrLoadModule = vite?.ssrLoadModule;
  return typeof ssrLoadModule === 'function' ? (file) => ssrLoadModule.call(vite, file) : undefined;
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
    importModule,
    log = console.log,
    warn = console.warn,
  }: {
    core: OntologyCore;
    sync: boolean;
    orphanScope: BootOrphanScope;
    dependencies?: Record<string, string[]>;
    /** Every linked package directory the server discovered (transitively). */
    packageDirs?: string[];
    /**
     * Imports a source register module (`src/ontologies/*.register.ts`) of a package directory
     * without built ones; in dev, Vite's `ssrLoadModule`.
     */
    importModule?: (file: string) => Promise<unknown>;
    log?: (message: string) => void;
    warn?: (message: string, err?: unknown) => void;
  },
): Promise<OntologyPhaseResult> {
  const result: OntologyPhaseResult = {
    ontologies: {written: [], skipped: [], graphs: [], droppedGraphs: []},
    shapeCheck: {errors: 0, warnings: 0},
  };

  if (core.registerInstalledOntologies && packageDirs.length) {
    try {
      if (importModule) await core.registerInstalledOntologies(packageDirs, {importModule});
      else await core.registerInstalledOntologies(packageDirs);
    } catch (err) {
      warn("[LinkedServer] registering the installed packages' ontologies failed:", err);
    }
  }

  let hierarchyLoaded = false;
  if (sync && ds) {
    // Every graph query that succeeded, in the order the sync sent them.
    const ops: Array<{kind: string; graph: string; ok?: boolean}> = [];
    const pending: Promise<unknown>[] = [];
    const stop = core.observeGraphQueries?.(ds, (query, settled) => {
      const op: {kind: string; graph: string; ok?: boolean} = {kind: query.kind, graph: query.graph};
      ops.push(op);
      pending.push(
        settled.then(
          () => (op.ok = true),
          () => undefined,
        ),
      );
    });
    try {
      const sync = await core.syncOntologies(ds, {orphanScope});
      await Promise.all(pending);
      const {graphs, droppedGraphs} = graphsWrittenAndDropped(ops.filter((op) => op.ok));
      result.ontologies = {written: sync.written, skipped: sync.skipped, graphs, droppedGraphs};
      hierarchyLoaded = true;
      // Core ≥ 2.41 says where it wrote (the store's `ontologyGraph`); an older core is told
      // apart by a write that sent no graph query.
      const where =
        sync.target === 'default'
          ? " (default graph: ontologyGraph is 'default')"
          : sync.fallback || (sync.target === undefined && !!stop && sync.written.length > 0 && graphs.length === 0)
            ? ' (default graph: the store has no graph queries)'
            : sync.target && sync.target !== 'package'
              ? ` (one shared graph <${sync.target}>)`
              : '';
      log(
        `[LinkedServer] ontology sync${where}: ` +
          `written ${list(sync.written)}; skipped ${list(sync.skipped)}` +
          (orphanScope === 'all' ? `; pruned ${list(sync.pruned)}` : '') +
          (graphs.length ? `; graphs written ${list(graphs)}` : '') +
          (droppedGraphs.length ? `; graphs dropped ${list(droppedGraphs)}` : ''),
      );
    } catch (err) {
      result.failure = asError(err);
      warn('[LinkedServer] ontology sync failed:', err);
    } finally {
      stop?.();
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
 * The graphs a sync left written and those it left dropped, from its successful graph queries in
 * order. A graph the run created and then dropped (the inference probe's temporary graphs) is in
 * neither list.
 */
export function graphsWrittenAndDropped(ops: Array<{kind: string; graph: string}>): {
  graphs: string[];
  droppedGraphs: string[];
} {
  const byGraph = new Map<string, string[]>();
  for (const {kind, graph} of ops) {
    const kinds = byGraph.get(graph) ?? [];
    kinds.push(kind);
    byGraph.set(graph, kinds);
  }
  const graphs: string[] = [];
  const droppedGraphs: string[] = [];
  for (const [graph, kinds] of byGraph) {
    const last = kinds[kinds.length - 1];
    if (last !== 'graph_drop') graphs.push(graph);
    else if (kinds[0] !== 'graph_create') droppedGraphs.push(graph);
  }
  return {graphs: graphs.sort(), droppedGraphs: droppedGraphs.sort()};
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
