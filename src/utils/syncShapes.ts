/**
 * The shape sync, as the server runs it at boot and when the host asks for a re-sync
 * (`POST /admin/sync-shapes`): core's `syncShapeGraphs` writes each package's shapes into its own
 * named graph of the app's default dataset (`{package IRI}/graph/shapes`, a `ShapesGraph` record
 * in the graph registry), skipped when the stored content hash matches, and the app's generated
 * single-owner shapes into the app's own shape graph, `{DATA_ROOT}/graph/shapes`. Shapes an
 * earlier sync wrote into the default graph are removed there once their package's graph holds
 * them. A store without graph queries gets core's default-graph shape sync instead.
 *
 * Where a package's Turtle comes from ({@link shapeTurtleSource}):
 * - an installed package: its built `lib/esm/data/shapes.ttl` (written by `linked build`); a
 *   package without that file gets no shape graph, and nothing is generated for it;
 * - the app's own packages (the app and its workspace packages): in dev, generated in process
 *   from their source shapes, through Vite's loader, so the core the SSR graph registered the
 *   shapes on writes them (the same bytes as `packageShapesTurtle`, which `linked build` writes);
 *   in a built app, their `lib/esm/data/shapes.ttl` when there is one, else generated in process.
 *
 * Kept apart from `LinkedServer` so the choices and the log can be tested without booting a
 * server.
 */
import fs from 'fs';
import path from 'path';

/** The orphan policies a booting server may run with. */
export type BootOrphanScope = 'all' | 'none';

/**
 * The orphan policy for the shape sync.
 *
 * `'none'` unless the operator sets `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true`, which drops the
 * shape graph of every package that is no longer registered in this process (never the app's own
 * graph).
 *
 * The registry is routinely a subset of what the dataset holds: shapes are deep-importable one
 * file at a time, an app's backend may import no shapes at all, and an app-data dataset also holds
 * shapes other writers put there. So nothing is pruned by default.
 */
export function bootOrphanScope(
  env: Record<string, string | undefined> = process.env,
): BootOrphanScope {
  return env.LINKED_SYNC_SHAPES_PRUNE_ORPHANS === 'true' ? 'all' : 'none';
}

/** What core's `syncShapeGraphs` reports (`@_linked/core/shapes/syncShapeGraphs`). */
export interface ShapeGraphSyncResult {
  written: string[];
  skipped: string[];
  pruned: string[];
  cleaned: number;
  appGraph?: 'written' | 'skipped' | 'dropped';
  defaultGraph?: number;
  /** The global `shapeGraph` target the run wrote in (core ≥ 2.41): `'package'`, `'default'` or an IRI. */
  target?: string;
  /** Set when a store without graph queries took the default-graph sync instead of `target`. */
  fallback?: true;
}

/** The subset of core's shape graph API this module calls. */
export interface ShapeGraphCore {
  syncShapeGraphs(
    ds: unknown,
    options: {
      orphanScope: BootOrphanScope;
      packages?: string[];
      turtleFor: (packageName: string) => Promise<string | undefined>;
      appShapes?: {graph: string; package?: string};
    },
  ): Promise<ShapeGraphSyncResult>;
  /** Every package with registered shapes (core counted for its built-ins). */
  packagesWithShapes(): string[];
  /** A package's shape graph IRI (`ShapesGraph.iriFor`). */
  shapesGraphFor(packageName: string): string;
}

/** Import core's shape graph sync. */
export async function loadShapeGraphCore(): Promise<ShapeGraphCore> {
  const sync = await import('@_linked/core/shapes/syncShapeGraphs');
  const turtle = await import('@_linked/core/shapes/shapesToTurtle');
  const graphs = await import('@_linked/core/shapes/NamedGraph');
  return {
    syncShapeGraphs: (ds, options) =>
      sync.syncShapeGraphs(ds as Parameters<typeof sync.syncShapeGraphs>[0], options),
    packagesWithShapes: () => turtle.packagesWithShapes(),
    shapesGraphFor: (packageName) => graphs.ShapesGraph.iriFor(packageName),
  };
}

/** Where `linked build` writes a package's shapes, relative to the package root. */
export const SHAPES_TURTLE_FILE = path.join('lib', 'esm', 'data', 'shapes.ttl');

/** A package's built `shapes.ttl`, or undefined when the package root has none. */
export function readShapesTurtle(packageDir: string | undefined): string | undefined {
  if (!packageDir) return undefined;
  try {
    return fs.readFileSync(path.join(packageDir, SHAPES_TURTLE_FILE), 'utf-8');
  } catch {
    return undefined;
  }
}

/** Where one package's Turtle comes from. */
export type ShapeTurtleSource =
  | {source: 'file'; text: string}
  | {source: 'generated'}
  | {source: 'none'};

/**
 * Where a registered package's Turtle comes from: in dev an own package is generated; otherwise
 * its built file when it has one; else an own package is generated and an installed one has
 * none (no shape graph, no generation).
 */
export function shapeTurtleSource(
  packageName: string,
  {
    own,
    dev,
    packageDir,
    read = readShapesTurtle,
  }: {
    /** Whether the package is the app or one of its workspace packages. */
    own: boolean;
    /** Whether the server runs with Vite (dev). */
    dev: boolean;
    /** The package root, when the server knows it. */
    packageDir: string | undefined;
    read?: (packageDir: string | undefined) => string | undefined;
  },
): ShapeTurtleSource {
  if (own && dev) return {source: 'generated'};
  const text = read(packageDir);
  if (text !== undefined) return {source: 'file', text};
  return own ? {source: 'generated'} : {source: 'none'};
}

/**
 * The app's own shape graph, `{DATA_ROOT}/graph/shapes`, or undefined when `DATA_ROOT` is not
 * an absolute IRI.
 */
export function appShapesGraph(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const root = env.DATA_ROOT?.trim().replace(/\/+$/, '');
  if (!root || !/^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(root)) return undefined;
  return `${root}/graph/shapes`;
}

/**
 * In dev, the generator for the app's own packages: core's `packageShapesTurtle` imported through
 * Vite's `ssrLoadModule`, the core the SSR graph registered the source shapes on. Undefined
 * without Vite.
 */
export function viteShapesTurtleGenerator(
  vite: {ssrLoadModule?: (url: string) => Promise<unknown>} | undefined | null,
): ((packageName: string) => Promise<string | undefined>) | undefined {
  const ssrLoadModule = vite?.ssrLoadModule;
  if (typeof ssrLoadModule !== 'function') return undefined;
  return async (packageName) => {
    const mod = (await ssrLoadModule.call(vite, '@_linked/core/shapes/shapesToTurtle')) as {
      packageShapesTurtle?: (name: string) => string | undefined;
    };
    if (typeof mod?.packageShapesTurtle !== 'function') {
      throw new Error('@_linked/core/shapes/shapesToTurtle has no packageShapesTurtle');
    }
    return mod.packageShapesTurtle(packageName);
  };
}

/** What one shape sync did, as the boot logs it and `POST /admin/sync-shapes` reports it. */
export interface ShapeGraphsReport {
  /** Packages whose shape graph was written, and those left as they were. */
  written: string[];
  skipped: string[];
  /** Packages no longer registered whose shape graph was dropped (`orphanScope: 'all'`). */
  pruned: string[];
  /** The shape graphs written (package graphs, then the app graph), by IRI. */
  graphs: string[];
  /** The app's own shape graph and what the sync did with it; absent without `DATA_ROOT`. */
  appGraph?: {graph: string; status: 'written' | 'skipped' | 'dropped'};
  /**
   * Registered packages with no Turtle, so with no shape graph: an installed package without
   * `shapes.ttl`, or an own package whose shapes could not be generated.
   */
  withoutTurtle: string[];
  /** Shapes an earlier sync had written into the default graph, removed now. */
  cleaned: number;
  /**
   * Set when the shapes went into the default graph (the global `shapeGraph` is `'default'`, or
   * it has no graph queries): the default-graph sync's writes.
   */
  defaultGraph?: number;
  /** The global `shapeGraph` target (`'package'`, `'default'` or a shared graph IRI), when core reports it. */
  target?: string;
  /** Set when the store has no graph queries, so the shapes went into the default graph instead of `target`. */
  fallback?: true;
}

const list = (names: string[]) => (names.length ? names.join(', ') : 'none');

/**
 * Sync the registered shapes into `ds`, one shape graph per package (see the module doc), and log
 * one line naming what was written and skipped, the graphs written, the packages without
 * `shapes.ttl` and the default-graph shapes removed. Throws when the sync fails.
 */
export async function syncShapeGraphsInto(
  ds: unknown,
  {
    core,
    orphanScope,
    isOwn,
    dev,
    packageDirOf,
    generate,
    appGraph,
    appPackage,
    read = readShapesTurtle,
    log = console.log,
    warn = console.warn,
  }: {
    core: ShapeGraphCore;
    orphanScope: BootOrphanScope;
    /** Whether a package is the app or one of its workspace packages. */
    isOwn: (packageName: string) => boolean;
    /** Whether the server runs with Vite (dev). */
    dev: boolean;
    /** A package's root directory, when the server knows it. */
    packageDirOf: (packageName: string) => string | undefined;
    /**
     * Generates an own package's Turtle (in dev through Vite's loader); undefined, or a result of
     * undefined, leaves the generation to the core that runs the sync.
     */
    generate?: (packageName: string) => Promise<string | undefined>;
    /** The app's own shape graph (`{DATA_ROOT}/graph/shapes`). */
    appGraph?: string;
    /** The app's package name, recorded on its shape graph's record. */
    appPackage?: string;
    read?: (packageDir: string | undefined) => string | undefined;
    log?: (message: string) => void;
    warn?: (message: string, err?: unknown) => void;
  },
): Promise<ShapeGraphsReport> {
  const sources = new Map<string, ShapeTurtleSource>();
  for (const name of core.packagesWithShapes()) {
    sources.set(name, shapeTurtleSource(name, {own: isOwn(name), dev, packageDir: packageDirOf(name), read}));
  }
  const noFile = [...sources].filter(([, s]) => s.source === 'none').map(([name]) => name);

  const turtleFor = async (name: string): Promise<string | undefined> => {
    const source = sources.get(name);
    if (source?.source === 'file') return source.text;
    if (source?.source !== 'generated' || !generate) return undefined;
    try {
      return await generate(name);
    } catch (err) {
      warn(`[LinkedServer] generating the shapes of ${name} through the dev loader failed; trying the server's core instead:`, err);
      return undefined;
    }
  };

  const result = await core.syncShapeGraphs(ds, {
    orphanScope,
    // A package without Turtle is left out: core would generate it otherwise.
    ...(noFile.length ? {packages: [...sources.keys()].filter((n) => !noFile.includes(n))} : {}),
    turtleFor,
    ...(appGraph ? {appShapes: {graph: appGraph, ...(appPackage ? {package: appPackage} : {})}} : {}),
  });

  // A package core neither wrote nor skipped got no Turtle at all: generation produced nothing
  // (in dev, the server's core may not hold the source shapes the dev loader registered). The
  // default-graph sync (a store without graph queries) reports no packages, so it is not checked.
  const covered = new Set([...result.written, ...result.skipped]);
  const notGenerated =
    result.defaultGraph !== undefined
      ? []
      : [...sources.keys()].filter((n) => !noFile.includes(n) && !covered.has(n));
  if (notGenerated.length) {
    warn(
      `[LinkedServer] no shapes could be generated for ${list(notGenerated.sort())}, so ` +
        `${notGenerated.length === 1 ? 'it has' : 'they have'} no shape graph this sync`,
    );
  }
  const withoutTurtle = [...noFile, ...notGenerated].sort();

  // A shared graph (the global `shapeGraph` is an IRI) holds every package and the app's shapes.
  const shared = result.target && result.target !== 'package' && result.target !== 'default' ? result.target : undefined;
  const report: ShapeGraphsReport = {
    written: result.written,
    skipped: result.skipped,
    pruned: result.pruned,
    // A shared graph is written whole or not at all: listed when the run wrote anything into it.
    graphs: shared
      ? result.written.length || result.appGraph === 'written' || result.pruned.length
        ? [shared]
        : []
      : result.written.map((name) => core.shapesGraphFor(name)),
    withoutTurtle,
    cleaned: result.cleaned,
  };
  if (result.target) report.target = result.target;
  if (result.fallback) report.fallback = true;
  if (appGraph && result.appGraph) {
    report.appGraph = {graph: shared ?? appGraph, status: result.appGraph};
    if (result.appGraph === 'written' && !shared) report.graphs.push(appGraph);
  }
  if (result.defaultGraph !== undefined) report.defaultGraph = result.defaultGraph;

  if (report.defaultGraph !== undefined) {
    const why =
      result.target === 'default' && !result.fallback
        ? "shapeGraph is 'default'"
        : 'the store has no graph queries';
    log(`[LinkedServer] shape sync (default graph: ${why}): ${report.defaultGraph} shape(s) written`);
  } else if (shared) {
    log(
      `[LinkedServer] shape graph sync (one shared graph <${shared}>): written ${list(report.written)}; ` +
        `skipped ${list(report.skipped)}` +
        (report.appGraph ? `; app shapes ${report.appGraph.status}` : '') +
        (report.pruned.length ? `; dropped from the graph ${list(report.pruned)}` : '') +
        (withoutTurtle.length ? `; no shapes.ttl (not in the graph): ${list(withoutTurtle)}` : ''),
    );
    // Unlike package graphs, which stay when a package goes missing, the shared graph is rebuilt
    // from the packages the run covers.
    if (withoutTurtle.length) {
      warn(
        `[LinkedServer] the shared shape graph <${shared}> holds no shapes of ${list(withoutTurtle)}: ` +
          'a package without Turtle in a run is left out of the rebuilt graph',
      );
    }
  } else {
    log(
      `[LinkedServer] shape graph sync: written ${list(report.written)}; skipped ${list(report.skipped)}` +
        (report.appGraph ? `; app graph ${report.appGraph.status}` : '; no app graph (DATA_ROOT not set)') +
        (report.graphs.length ? `; graphs written ${list(report.graphs)}` : '') +
        (orphanScope === 'all' ? `; pruned ${list(report.pruned)}` : '') +
        (report.cleaned ? `; ${report.cleaned} default-graph shape(s) removed` : '') +
        (withoutTurtle.length ? `; no shapes.ttl (no shape graph): ${list(withoutTurtle)}` : ''),
    );
  }
  if (orphanScope === 'all' && withoutTurtle.length && !shared) {
    warn(
      '[LinkedServer] orphaned shape graphs were not pruned: core prunes only when the sync covers ' +
        `every registered package, and ${list(withoutTurtle)} has no Turtle`,
    );
  }
  return report;
}

/**
 * @deprecated The default-graph shape sync's callback type; the server now syncs shape graphs with
 * {@link syncShapeGraphsInto}. Kept so code built against an earlier server still compiles.
 */
export type SyncShapesFn = (
  ds: unknown,
  options: {orphanScope: BootOrphanScope},
) => Promise<Array<() => Promise<void>>>;

/**
 * @deprecated Use {@link syncShapeGraphsInto}, which writes each package's shapes into its own
 * shape graph. This runs the old default-graph sync: it plans every registered shape with
 * `syncShapes` (the orphan policy from {@link bootOrphanScope}) and runs the writes in batches
 * of 8. Kept so code built against an earlier server keeps working.
 */
export async function materializeShapes(
  ds: unknown,
  syncShapes: SyncShapesFn,
  {
    env = process.env,
    log = console.log,
  }: {
    env?: Record<string, string | undefined>;
    log?: (message: string) => void;
  } = {},
): Promise<{count: number; orphanScope: BootOrphanScope}> {
  const orphanScope = bootOrphanScope(env);
  const thunks = await syncShapes(ds, {orphanScope});
  for (let i = 0; i < thunks.length; i += 8) {
    await Promise.all(thunks.slice(i, i + 8).map((run) => run()));
  }
  log(
    `[LinkedServer] synced shapes into the default graph with orphanScope '${orphanScope}': ` +
      `${thunks.length} operation(s)`,
  );
  return {count: thunks.length, orphanScope};
}
