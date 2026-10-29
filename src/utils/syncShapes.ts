/**
 * The shape sync, as the server runs it at boot and when the host asks for a re-sync
 * (`POST /admin/sync-shapes`): core's `syncShapeGraphsRouted` writes each package's shapes into its
 * own named graph (`{package IRI}/graph/shapes`, a `ShapesGraph` record in the graph registry) of
 * every dataset the storage routing needs them in (see "Which datasets the syncs write to" in
 * core's README), skipped when the stored content hash matches, and the app's generated
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
  /**
   * Core's routed sync (`@_linked/core/shapes/syncTargets`): the same options without a dataset;
   * each package's graph goes where the routing needs it. Optional so a test double can leave it out.
   */
  syncShapeGraphsRouted?(options: {
    orphanScope: BootOrphanScope;
    packages?: string[];
    turtleFor: (packageName: string) => Promise<string | undefined>;
    appShapes?: {graph: string; package?: string};
  }): Promise<RoutedSyncReport<ShapeGraphSyncResult>>;
  /**
   * Core's `graphContent` (`@_linked/core/shapes/syncTargets`): what the `'package'`-mode syncs
   * would write, writing nothing. Optional so a test double can leave it out.
   */
  graphContent?(options: {
    packages?: string[];
    turtleFor: (packageName: string) => Promise<string | undefined>;
    appShapes?: {graph: string};
  }): Promise<GraphContents>;
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
  const targets = await import('@_linked/core/shapes/syncTargets');
  return {
    syncShapeGraphs: (ds, options) =>
      sync.syncShapeGraphs(ds as Parameters<typeof sync.syncShapeGraphs>[0], options),
    syncShapeGraphsRouted: (options) => targets.syncShapeGraphsRouted(options),
    graphContent: (options) => targets.graphContent(options),
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
 * The head of a sync's log line: the packages written, then how many were unchanged (`skipped`
 * in the syncs' results): `written a, b; 17 unchanged`, `written a, b`, or `19 unchanged`.
 */
export function writtenAndUnchanged(written: string[], unchanged: string[]): string {
  const parts = written.length ? [`written ${written.join(', ')}`] : [];
  if (unchanged.length || !written.length) parts.push(`${unchanged.length} unchanged`);
  return parts.join('; ');
}

/** An app graph's status in a log line: core's `skipped` is an unchanged graph. */
const appGraphStatus = (status: 'written' | 'skipped' | 'dropped') => (status === 'skipped' ? 'unchanged' : status);

/** The options of {@link syncShapeGraphsInto} and {@link syncRoutedShapeGraphs}. */
export interface ShapeGraphSyncOptions {
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
}

/** Where each registered package's Turtle comes from, and the sync options that follow from it. */
export interface ShapeTurtleSources {
  sources: Map<string, ShapeTurtleSource>;
  /** Installed packages without `shapes.ttl`: no shape graph, left out of the run. */
  noFile: string[];
  /** The package subset to sync: set only when some package has no Turtle file. */
  packages?: string[];
  turtleFor: (packageName: string) => Promise<string | undefined>;
}

/**
 * Where each registered package's Turtle comes from ({@link shapeTurtleSource}) and the
 * `turtleFor` the syncs read it through. Shared by the syncs and the graph content endpoint, so
 * both see the same bytes.
 */
export function shapeTurtleSources({
  core,
  isOwn,
  dev,
  packageDirOf,
  generate,
  read = readShapesTurtle,
  warn = console.warn,
}: Pick<ShapeGraphSyncOptions, 'core' | 'isOwn' | 'dev' | 'packageDirOf' | 'generate' | 'read' | 'warn'>): ShapeTurtleSources {
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
  return {
    sources,
    noFile,
    ...(noFile.length ? {packages: [...sources.keys()].filter((n) => !noFile.includes(n))} : {}),
    turtleFor,
  };
}

/**
 * The packages with a Turtle source that no run covered (their generation gave nothing), with one
 * warning naming them. None when the shapes went into the default graph.
 */
function notGeneratedIn(
  results: ShapeGraphSyncResult[],
  {sources, noFile}: ShapeTurtleSources,
  warn: (message: string, err?: unknown) => void,
): string[] {
  if (results.some((r) => r.defaultGraph !== undefined)) return [];
  const covered = new Set(results.flatMap((r) => [...r.written, ...r.skipped]));
  const notGenerated = [...sources.keys()].filter((n) => !noFile.includes(n) && !covered.has(n)).sort();
  if (notGenerated.length) {
    warn(
      `[LinkedServer] no shapes could be generated for ${list(notGenerated)}, so ` +
        `${notGenerated.length === 1 ? 'it has' : 'they have'} no shape graph this sync`,
    );
  }
  return notGenerated;
}

/** One sync's report (one dataset), from core's result. */
function reportOf(
  result: ShapeGraphSyncResult,
  core: ShapeGraphCore,
  {noFile}: ShapeTurtleSources,
  appGraph: string | undefined,
  notGenerated: string[],
): ShapeGraphsReport {
  const withoutTurtle = [...noFile, ...notGenerated].sort();
  const shared = sharedTarget(result);
  const report: ShapeGraphsReport = {
    written: result.written,
    skipped: result.skipped,
    pruned: result.pruned,
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
  return report;
}

const sharedTarget = (result: {target?: string}): string | undefined =>
  result.target && result.target !== 'package' && result.target !== 'default' ? result.target : undefined;

/** Log one sync's report; `where` names the dataset when a routed sync wrote into several. */
function logReport(
  report: ShapeGraphsReport,
  orphanScope: BootOrphanScope,
  where: string,
  log: (message: string) => void,
  warn: (message: string, err?: unknown) => void,
): void {
  const {withoutTurtle} = report;
  const shared = sharedTarget(report);
  if (report.defaultGraph !== undefined) {
    const why =
      report.target === 'default' && !report.fallback ? "shapeGraph is 'default'" : 'the store has no graph queries';
    log(`[LinkedServer] shape sync${where} (default graph: ${why}): ${report.defaultGraph} shape(s) written`);
  } else if (shared) {
    log(
      `[LinkedServer] shape graph sync${where} (one shared graph <${shared}>): ` +
        writtenAndUnchanged(report.written, report.skipped) +
        (report.appGraph ? `; app shapes ${appGraphStatus(report.appGraph.status)}` : '') +
        (report.pruned.length ? `; dropped from the graph ${list(report.pruned)}` : '') +
        (withoutTurtle.length ? `; no shapes.ttl (not in the graph): ${list(withoutTurtle)}` : ''),
    );
    if (withoutTurtle.length) {
      warn(
        `[LinkedServer] the shared shape graph <${shared}> holds no shapes of ${list(withoutTurtle)}: ` +
          'a package without Turtle in a run is left out of the rebuilt graph',
      );
    }
  } else {
    log(
      `[LinkedServer] shape graph sync${where}: ${writtenAndUnchanged(report.written, report.skipped)}` +
        (report.appGraph ? `; app graph ${appGraphStatus(report.appGraph.status)}` : '; no app graph (DATA_ROOT not set)') +
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
}

/**
 * Sync the registered shapes into `ds`, one shape graph per package (see the module doc), and log
 * one line naming what was written and skipped, the graphs written, the packages without
 * `shapes.ttl` and the default-graph shapes removed. Throws when the sync fails. The server's boot
 * follows the routing instead ({@link syncRoutedShapeGraphs}); this syncs one given dataset.
 */
export async function syncShapeGraphsInto(ds: unknown, options: ShapeGraphSyncOptions): Promise<ShapeGraphsReport> {
  const {core, orphanScope, appGraph, appPackage, log = console.log, warn = console.warn} = options;
  const turtle = shapeTurtleSources(options);
  const result = await core.syncShapeGraphs(ds, {
    orphanScope,
    ...(turtle.packages ? {packages: turtle.packages} : {}),
    turtleFor: turtle.turtleFor,
    ...(appGraph ? {appShapes: {graph: appGraph, ...(appPackage ? {package: appPackage} : {})}} : {}),
  });
  const report = reportOf(result, core, turtle, appGraph, notGeneratedIn([result], turtle, warn));
  logReport(report, orphanScope, '', log, warn);
  return report;
}

/** A package graph a routed sync dropped or found left behind (core's `RoutedGraph`). */
export interface RoutedGraphReport {
  dataset: string;
  package: string;
  graph: string;
}

/** What core's routed syncs report (`@_linked/core/shapes/syncTargets`). */
export interface RoutedSyncReport<R> {
  targets: Array<{dataset: string; result: R}>;
  pruned: RoutedGraphReport[];
  leftovers: RoutedGraphReport[];
  failed: Array<{dataset: string; error: string}>;
}

/** The routed part of a shape sync's report: per target dataset, and what routing left behind. */
export interface RoutedShapeGraphsReport extends ShapeGraphsReport {
  /** Each dataset the shapes went to (the default one first) and what the sync did there. */
  datasets: Array<{dataset: string} & ShapeGraphsReport>;
  /** Package shape graphs dropped from the default dataset: routing sends them elsewhere now. */
  prunedGraphs: RoutedGraphReport[];
  /** Package shape graphs left in another dataset routing no longer sends them to (reported, never dropped). */
  leftovers: RoutedGraphReport[];
}

const union = (lists: string[][]): string[] => [...new Set(lists.flat())].sort();

/**
 * Sync the registered shapes where the routing needs them (core's `syncShapeGraphsRouted`): each
 * package's shape graph into every dataset its shapes and the shape shapes route to, the app graph
 * into the datasets of the shapes declaring `contains` properties, and the graphs routing no longer
 * sends to the default dataset dropped there. Logs one line per dataset (as
 * {@link syncShapeGraphsInto} does, naming the dataset when there are several) and one per graph
 * dropped or left behind. The answer's top-level fields join the datasets'. Throws, after the other
 * datasets synced, when one failed, naming each.
 */
export async function syncRoutedShapeGraphs(options: ShapeGraphSyncOptions): Promise<RoutedShapeGraphsReport> {
  const {core, orphanScope, appGraph, appPackage, log = console.log, warn = console.warn} = options;
  if (!core.syncShapeGraphsRouted) {
    throw new Error("@_linked/core has no syncShapeGraphsRouted: this server needs the core it was built with");
  }
  const turtle = shapeTurtleSources(options);
  const routed = await core.syncShapeGraphsRouted({
    orphanScope,
    ...(turtle.packages ? {packages: turtle.packages} : {}),
    turtleFor: turtle.turtleFor,
    ...(appGraph ? {appShapes: {graph: appGraph, ...(appPackage ? {package: appPackage} : {})}} : {}),
  });
  const several = routed.targets.length > 1;
  const notGenerated = notGeneratedIn(routed.targets.map((t) => t.result), turtle, warn);
  const datasets = routed.targets.map(({dataset, result}) => {
    const report = reportOf(result, core, turtle, appGraph, notGenerated);
    logReport(report, orphanScope, several ? ` in ${dataset}` : '', log, warn);
    return {dataset, ...report};
  });
  for (const {dataset, package: name, graph} of routed.pruned) {
    log(`[LinkedServer] shape graph sync: dropped <${graph}> (${name}) from ${dataset}: routing sends its shapes elsewhere`);
  }
  const first = datasets[0];
  const report: RoutedShapeGraphsReport = {
    written: union(datasets.map((d) => d.written)),
    skipped: union(datasets.map((d) => d.skipped)).filter((n) => !datasets.some((d) => d.written.includes(n))),
    pruned: union(datasets.map((d) => d.pruned)),
    graphs: union(datasets.map((d) => d.graphs)),
    withoutTurtle: union(datasets.map((d) => d.withoutTurtle)),
    cleaned: datasets.reduce((n, d) => n + d.cleaned, 0),
    datasets,
    prunedGraphs: routed.pruned,
    leftovers: routed.leftovers,
  };
  const app = datasets.find((d) => d.appGraph?.status === 'written') ?? datasets.find((d) => d.appGraph);
  if (app?.appGraph) report.appGraph = app.appGraph;
  if (datasets.some((d) => d.defaultGraph !== undefined)) {
    report.defaultGraph = datasets.reduce((n, d) => n + (d.defaultGraph ?? 0), 0);
  }
  if (first?.target) report.target = first.target;
  if (datasets.some((d) => d.fallback)) report.fallback = true;
  if (routed.failed.length) {
    throw new Error(
      `the shape sync failed in ${routed.failed.map((f) => `${f.dataset}: ${f.error}`).join('; ')}` +
        (datasets.length ? ` (synced: ${datasets.map((d) => d.dataset).join(', ')})` : ''),
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

/** One graph's content as the `'package'`-mode sync writes and records it (core's `GraphContentPart`). */
export interface GraphContentPart {
  graph: string;
  mediaType: 'text/turtle' | 'application/n-triples';
  text: string;
  hash: string;
  sources: string[];
}

/** What core's `graphContent` answers. */
export interface GraphContents {
  packages: Array<{name: string; shapes?: GraphContentPart; ontology?: GraphContentPart}>;
  appGraph?: GraphContentPart | null;
  withoutTurtle: string[];
  unreadable: string[];
}

/**
 * The content of the app's graphs as the `'package'`-mode syncs would write them, writing nothing
 * (core's `graphContent`), with the server's choice of each package's Turtle
 * ({@link shapeTurtleSources}): an installed package without `shapes.ttl` gets no shape graph here
 * either (it is listed in `withoutTurtle`), exactly as the sync leaves it out. `packages` limits
 * the answer; without it every registered package with shapes or ontology data. The app graph is
 * answered when `appGraph` (`{DATA_ROOT}/graph/shapes`) is given.
 */
export async function graphContentOf(
  options: Pick<ShapeGraphSyncOptions, 'core' | 'isOwn' | 'dev' | 'packageDirOf' | 'generate' | 'read' | 'warn' | 'appGraph'> & {
    packages?: string[];
  },
): Promise<GraphContents> {
  const {core, packages, appGraph} = options;
  if (!core.graphContent) {
    throw new Error('@_linked/core has no graphContent: this server needs the core it was built with');
  }
  const turtle = shapeTurtleSources(options);
  const content = await core.graphContent({
    ...(packages ? {packages} : {}),
    turtleFor: turtle.turtleFor,
    ...(appGraph ? {appShapes: {graph: appGraph}} : {}),
  });
  const noFile = new Set(turtle.noFile);
  const withoutTurtle = new Set(content.withoutTurtle);
  for (const entry of content.packages) {
    if (!noFile.has(entry.name)) continue;
    delete entry.shapes;
    withoutTurtle.add(entry.name);
  }
  return {...content, withoutTurtle: [...withoutTurtle].sort()};
}
