import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadOntologyCore,
  graphsWrittenAndDropped,
  ontologyPackageDirs,
  runOntologyPhase,
  sourceModuleImporter,
  shapeSyncOn,
  type OntologyCore,
} from '../utils/ontologySync.js';
import { readDependencyLists } from '../utils/linkedDependencies.js';

type Finding = Awaited<ReturnType<OntologyCore['checkShapeHierarchy']>>[number];

const GA = 'https://linked.cm/pkg/x-a/graph/ontology';

// A stand-in for core's ontology API that records the order of calls.
function fakeCore({
  syncFails = false,
  findings = [] as Finding[],
  checkFails = false,
  withHierarchy = true,
  withRegister = true,
  registerFails = false,
  graphQueries = [{ kind: 'graph_replace', graph: GA }] as Array<{ kind: string; graph: string; fails?: boolean }>,
  where = {} as { target?: string },
} = {}) {
  const calls: string[] = [];
  const seen: {
    ds?: unknown;
    observed?: unknown;
    unobserved?: boolean;
    syncOptions?: unknown;
    checkOptions?: unknown;
    packageDirs?: string[];
    registerOptions?: { importModule?: (file: string) => Promise<unknown> };
  } = {};
  let observer: ((q: { kind: string; graph: string }, settled: Promise<unknown>) => void) | undefined;
  const core: OntologyCore = {
    async syncOntologies(ds, options) {
      calls.push('sync');
      seen.ds = ds;
      seen.syncOptions = options;
      if (syncFails) throw new Error('store unreachable');
      for (const q of graphQueries) {
        observer?.(q, q.fails ? Promise.reject(new Error('refused')) : Promise.resolve({}));
      }
      return { written: ['@x/a'], skipped: ['@x/b'], pruned: [], ...where };
    },
    observeGraphQueries(ds, onGraph) {
      seen.observed = ds;
      observer = onGraph;
      return () => {
        seen.unobserved = true;
        observer = undefined;
      };
    },
    async checkShapeHierarchy(options) {
      calls.push('check');
      seen.checkOptions = options;
      if (checkFails) throw new Error('check bug');
      return findings;
    },
    loadOntologyHierarchy: withHierarchy
      ? async () => {
          calls.push('hierarchy');
          return [];
        }
      : undefined,
    registerInstalledOntologies: withRegister
      ? async (packageDirs, options) => {
          calls.push('register');
          seen.packageDirs = packageDirs;
          seen.registerOptions = options;
          if (registerFails) throw new Error('bad register module');
          return ['@x/a'];
        }
      : undefined,
  };
  return { core, calls, seen };
}

const quiet = { log: () => {}, warn: () => {} };

describe('the boot switch', () => {
  it("is linked.config's syncShapesOnBoot, one switch for the shape and the ontology sync: off only when false", () => {
    expect(shapeSyncOn(undefined)).toBe(true);
    expect(shapeSyncOn(true)).toBe(true);
    expect(shapeSyncOn(false)).toBe(false);
  });
});

describe('runOntologyPhase', () => {
  it('syncs every package into the dataset with the explicit orphan policy, then checks', async () => {
    const { core, calls, seen } = fakeCore();
    const ds = { name: 'app-data' };
    const dependencies = { app: ['@x/a'] };
    const result = await runOntologyPhase(ds, { core, sync: true, orphanScope: 'none', dependencies, ...quiet });
    expect(calls).toEqual(['sync', 'check']);
    expect(seen.unobserved).toBe(true);
    // No `packages` filter: a filter would sync only those packages.
    expect(seen.syncOptions).toEqual({ orphanScope: 'none' });
    expect(seen.ds).toBe(ds);
    expect(seen.observed).toBe(ds);
    expect(seen.checkOptions).toEqual({ dependencies });
    expect(result).toEqual({
      ontologies: { written: ['@x/a'], skipped: ['@x/b'], graphs: [GA], droppedGraphs: [] },
      shapeCheck: { errors: 0, warnings: 0 },
    });
  });

  it("registers the installed packages' ontologies from every linked package directory first", async () => {
    const { core, calls, seen } = fakeCore();
    const packageDirs = ['/app/node_modules/@x/a', '/app/node_modules/@x/b'];
    await runOntologyPhase({}, { core, sync: true, orphanScope: 'none', packageDirs, ...quiet });
    expect(calls).toEqual(['register', 'sync', 'check']);
    expect(seen.packageDirs).toEqual(packageDirs);
  });

  it('registers also when the sync is off, so the check sees every package', async () => {
    const { core, calls } = fakeCore();
    await runOntologyPhase({}, { core, sync: false, orphanScope: 'none', packageDirs: ['/d'], ...quiet });
    expect(calls).toEqual(['register', 'hierarchy', 'check']);
  });

  it('a failed registration is warned about and the sync and check still run', async () => {
    const { core, calls } = fakeCore({ registerFails: true });
    const warnings: string[] = [];
    const result = await runOntologyPhase({}, {
      core,
      sync: true,
      orphanScope: 'none',
      packageDirs: ['/d'],
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(calls).toEqual(['register', 'sync', 'check']);
    expect(warnings[0]).toContain("registering the installed packages' ontologies failed");
    expect(result.failure).toBeUndefined();
  });

  it('passes importModule to the registration, for source packages', async () => {
    const { core, seen } = fakeCore();
    const importModule = async (file: string) => file;
    await runOntologyPhase({}, { core, sync: true, orphanScope: 'none', packageDirs: ['/d'], importModule, ...quiet });
    expect(seen.registerOptions?.importModule).toBe(importModule);
    const without = fakeCore();
    await runOntologyPhase({}, { core: without.core, sync: true, orphanScope: 'none', packageDirs: ['/d'], ...quiet });
    expect(without.seen.registerOptions).toBeUndefined();
  });

  it('registers nothing without package directories, or with a core that cannot', async () => {
    const withDirs = fakeCore({ withRegister: false });
    await runOntologyPhase({}, { core: withDirs.core, sync: true, orphanScope: 'none', packageDirs: ['/d'], ...quiet });
    expect(withDirs.calls).toEqual(['sync', 'check']);
    const noDirs = fakeCore();
    await runOntologyPhase({}, { core: noDirs.core, sync: true, orphanScope: 'none', ...quiet });
    expect(noDirs.calls).toEqual(['sync', 'check']);
  });

  it('loads the in-memory hierarchy when the sync is off, and syncs nothing', async () => {
    const { core, calls } = fakeCore();
    const lines: string[] = [];
    const result = await runOntologyPhase({}, {
      core,
      sync: false,
      orphanScope: 'none',
      log: (m) => lines.push(m),
      warn: () => {},
    });
    expect(calls).toEqual(['hierarchy', 'check']);
    expect(result.ontologies).toEqual({ written: [], skipped: [], graphs: [], droppedGraphs: [] });
    expect(lines.some((l) => l.includes('ontology sync'))).toBe(false);
  });

  it('skips the sync without a default dataset', async () => {
    const { core, calls } = fakeCore();
    await runOntologyPhase(undefined, { core, sync: true, orphanScope: 'none', ...quiet });
    expect(calls).toEqual(['hierarchy', 'check']);
  });

  it('works with a core that has no hierarchy loader', async () => {
    const { core, calls } = fakeCore({ withHierarchy: false });
    await runOntologyPhase({}, { core, sync: false, orphanScope: 'none', ...quiet });
    expect(calls).toEqual(['check']);
  });

  it('reports a failed sync and still runs the check', async () => {
    const { core, calls } = fakeCore({ syncFails: true });
    const warnings: string[] = [];
    const result = await runOntologyPhase({}, {
      core,
      sync: true,
      orphanScope: 'none',
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(calls).toEqual(['sync', 'hierarchy', 'check']);
    expect(result.failure?.message).toBe('store unreachable');
    expect(warnings[0]).toContain('ontology sync failed');
  });

  it('reports a shape check that throws in shapeCheck, not as the phase failure', async () => {
    const { core, calls } = fakeCore({ checkFails: true });
    const warnings: string[] = [];
    const result = await runOntologyPhase({}, {
      core,
      sync: true,
      orphanScope: 'none',
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(calls).toEqual(['sync', 'check']);
    expect(result.failure).toBeUndefined();
    expect(result.shapeCheck).toEqual({ errors: 0, warnings: 0, failed: 'check bug' });
    expect(warnings).toContain('[LinkedServer] shape check failed:');
  });

  it('counts the findings by severity and logs each one', async () => {
    const findings: Finding[] = [
      { kind: 'extends-without-subclass', severity: 'error', message: 'sC extends sD' },
      { kind: 'subclass-without-extends', severity: 'warning', message: 'A is a B' },
      { kind: 'borrowed-target-class', severity: 'warning', message: 'borrowed' },
    ];
    const { core } = fakeCore({ findings });
    const lines: string[] = [];
    const warnings: string[] = [];
    const result = await runOntologyPhase({}, {
      core,
      sync: true,
      orphanScope: 'none',
      log: (m) => lines.push(m),
      warn: (m) => warnings.push(m),
    });
    expect(result.shapeCheck).toEqual({ errors: 1, warnings: 2 });
    expect(lines).toEqual([
      `[LinkedServer] ontology sync: written @x/a; 1 unchanged; graphs written ${GA}`,
      '[LinkedServer] shape check: 1 error(s), 2 warning(s)',
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('error (extends-without-subclass): sC extends sD');
  });

  it('logs nothing for a clean shape check', async () => {
    const { core } = fakeCore();
    const lines: string[] = [];
    const result = await runOntologyPhase({}, {
      core,
      sync: true,
      orphanScope: 'none',
      log: (m) => lines.push(m),
      warn: () => {},
    });
    expect(result.shapeCheck).toEqual({ errors: 0, warnings: 0 });
    expect(lines).toEqual([`[LinkedServer] ontology sync: written @x/a; 1 unchanged; graphs written ${GA}`]);
  });
});

describe('graphsWrittenAndDropped', () => {
  it("leaves out a graph the run created and dropped (the probe's), and keeps the last state of the rest", () => {
    expect(
      graphsWrittenAndDropped([
        { kind: 'graph_create', graph: 'probe' },
        { kind: 'graph_create', graph: 'a' },
        { kind: 'graph_replace', graph: 'b' },
        { kind: 'graph_drop', graph: 'probe' },
        { kind: 'graph_drop', graph: 'c' },
        { kind: 'graph_drop', graph: 'd' },
        { kind: 'graph_create', graph: 'd' },
      ]),
    ).toEqual({ graphs: ['a', 'b', 'd'], droppedGraphs: ['c'] });
  });
});

describe('runOntologyPhase: where the sync wrote', () => {
  const run = async (where: { target?: string }, graphQueries: Array<{ kind: string; graph: string }>) => {
    const { core } = fakeCore({ where, graphQueries });
    const lines: string[] = [];
    await runOntologyPhase({}, { core, sync: true, orphanScope: 'none', log: (m) => lines.push(m), warn: () => {} });
    return lines[0];
  };

  it("names the default graph of ontologyGraph 'default' and a shared graph", async () => {
    expect(await run({ target: 'default' }, [])).toMatch(/^\[LinkedServer\] ontology sync \(default graph: ontologyGraph is 'default'\): written @x\/a/);
    const shared = 'https://data.example.org/graph/ontology';
    expect(await run({ target: shared }, [{ kind: 'graph_replace', graph: shared }])).toContain(
      `ontology sync (one shared graph <${shared}>): written @x/a`,
    );
    expect(await run({ target: 'package' }, [{ kind: 'graph_replace', graph: GA }])).toMatch(/^\[LinkedServer\] ontology sync: written/);
  });
});

describe('readDependencyLists', () => {
  it('reads dependencies and peerDependencies of the app and of every package', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deplists-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@x/a', dependencies: { '@x/c': '1' }, peerDependencies: { '@x/b': '1', '@x/c': '1' } })
    );
    const lists = readDependencyLists(
      new Map([
        ['@x/a', dir],
        ['@x/missing', path.join(dir, 'nope')],
      ]),
      { name: 'app', dependencies: { '@x/a': '1' } }
    );
    expect(lists).toEqual({ app: ['@x/a'], '@x/a': ['@x/b', '@x/c'] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadOntologyCore', () => {
  it("imports core's sync and check, and the hierarchy loader only when core has it", async () => {
    const core = await loadOntologyCore();
    expect(typeof core.syncOntologies).toBe('function');
    expect(typeof core.checkShapeHierarchy).toBe('function');
    const hierarchy = (await import('@_linked/core/ontology/hierarchy')) as Record<string, unknown>;
    expect(typeof core.loadOntologyHierarchy).toBe(
      typeof hierarchy.loadOntologyHierarchy === 'function' ? 'function' : 'undefined'
    );
  });

  it("imports core's registration of installed packages, which imports each package's register modules", async () => {
    const core = await loadOntologyCore();
    expect(typeof core.registerInstalledOntologies).toBe('function');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-'));
    const withRegister = path.join(root, 'with');
    const without = path.join(root, 'without');
    fs.mkdirSync(path.join(withRegister, 'lib/esm/ontologies'), { recursive: true });
    fs.mkdirSync(without);
    fs.writeFileSync(path.join(withRegister, 'package.json'), JSON.stringify({ name: '@x/installed', type: 'module' }));
    fs.writeFileSync(path.join(without, 'package.json'), JSON.stringify({ name: '@x/plain', type: 'module' }));
    // Stands in for `linkedOntology(...)`: records that the module ran.
    fs.writeFileSync(
      path.join(withRegister, 'lib/esm/ontologies/x.register.js'),
      "globalThis.__bootOntologySyncRegistered = (globalThis.__bootOntologySyncRegistered ?? 0) + 1;\n"
    );
    const g = globalThis as { __bootOntologySyncRegistered?: number };
    try {
      expect(await core.registerInstalledOntologies!([without, withRegister])).toEqual(['@x/installed']);
      expect(g.__bootOntologySyncRegistered).toBe(1);
    } finally {
      delete g.__bootOntologySyncRegistered;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the directories and the loader the server registers with', () => {
  it("adds the app's workspace packages after the discovered ones, once each", () => {
    expect(ontologyPackageDirs(['/app/node_modules/@x/a', '/app/packages/b'], ['/app/packages/b', '/app/packages/b-ont'])).toEqual([
      '/app/node_modules/@x/a',
      '/app/packages/b',
      '/app/packages/b-ont',
    ]);
  });

  it("is Vite's ssrLoadModule in dev, and nothing without Vite", async () => {
    const loaded: string[] = [];
    const vite = {
      prefix: 'vite:',
      async ssrLoadModule(this: { prefix: string }, url: string) {
        loaded.push(this.prefix + url);
        return {};
      },
    };
    const importModule = sourceModuleImporter(vite);
    await importModule!('/app/packages/b-ont/src/ontologies/b.register.ts');
    expect(loaded).toEqual(['vite:/app/packages/b-ont/src/ontologies/b.register.ts']);
    expect(sourceModuleImporter(undefined)).toBeUndefined();
    expect(sourceModuleImporter({})).toBeUndefined();
  });

  it("registers a source package's register modules through the loader with the real core", async () => {
    const core = await loadOntologyCore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'));
    const source = path.join(root, 'b-ont');
    fs.mkdirSync(path.join(source, 'src/ontologies'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'b-ont', type: 'module' }));
    fs.writeFileSync(path.join(source, 'src/ontologies/b.register.ts'), '');
    const imported: string[] = [];
    try {
      expect(await core.registerInstalledOntologies!([source])).toEqual([]);
      expect(
        await core.registerInstalledOntologies!([source], {
          importModule: async (file) => {
            imported.push(file);
          },
        })
      ).toEqual(['b-ont']);
      expect(imported).toEqual([path.join(fs.realpathSync(source), 'src/ontologies/b.register.ts')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runOntologyPhase: the graphs the sync wrote', () => {
  it('reports written and dropped graphs, sorted, and leaves out a refused graph query', async () => {
    const GB = 'https://linked.cm/pkg/x-b/graph/ontology';
    const GOLD = 'https://linked.cm/pkg/x-old/graph/ontology';
    const { core, seen } = fakeCore({
      graphQueries: [
        { kind: 'graph_replace', graph: GB },
        { kind: 'graph_create', graph: GA },
        { kind: 'graph_drop', graph: GOLD },
        { kind: 'graph_replace', graph: 'https://linked.cm/pkg/x-c/graph/ontology', fails: true },
      ],
    });
    const lines: string[] = [];
    const result = await runOntologyPhase({}, { core, sync: true, orphanScope: 'all', log: (m) => lines.push(m), warn: () => {} });
    expect(result.ontologies.graphs).toEqual([GA, GB]);
    expect(result.ontologies.droppedGraphs).toEqual([GOLD]);
    expect(lines[0]).toBe(
      `[LinkedServer] ontology sync: written @x/a; 1 unchanged; pruned none; graphs written ${GA}, ${GB}; graphs dropped ${GOLD}`,
    );
    expect(seen.unobserved).toBe(true);
  });

  it('stops observing when the sync fails', async () => {
    const { core, seen } = fakeCore({ syncFails: true });
    const result = await runOntologyPhase({}, { core, sync: true, orphanScope: 'none', ...quiet });
    expect(result.failure?.message).toBe('store unreachable');
    expect(seen.unobserved).toBe(true);
  });

  it("core's observer reports only graph queries sent to the synced dataset", async () => {
    const core = await loadOntologyCore();
    const { dispatchGraphQuery } = await import('@_linked/core/queries/queryDispatch');
    const ds = { graphQuery: async (q: any) => ({ graph: q.graph, changed: true }) } as any;
    const other = { graphQuery: async (q: any) => ({ graph: q.graph, changed: true }) } as any;
    const seenGraphs: string[] = [];
    const stop = core.observeGraphQueries!(ds, (q) => seenGraphs.push(q.graph));
    const q = (graph: string) => ({ kind: 'graph_drop' as const, graph, recordClass: 'https://linked.cm/ont/core/OntologyGraph' });
    await dispatchGraphQuery(q('http://e/g1'), ds);
    await dispatchGraphQuery(q('http://e/g2'), other);
    stop();
    await dispatchGraphQuery(q('http://e/g3'), ds);
    expect(seenGraphs).toEqual(['http://e/g1']);
  });
});

describe('runOntologyPhase, routed', () => {
  const GB = 'https://linked.cm/pkg/x-b/graph/ontology';

  /** A core whose routed sync wrote x-a into "main" and x-b into both datasets. */
  function routedCore(failed: Array<{ dataset: string; error: string }> = []) {
    const listeners: Array<{ ds: unknown; on: (q: { kind: string; graph: string }, s: Promise<unknown>) => void }> = [];
    const main = { id: 'main' };
    const two = { id: 'two' };
    const calls: string[] = [];
    const core: OntologyCore = {
      syncOntologies: async () => {
        throw new Error('not called');
      },
      routedDatasets: () => [main, two],
      observeGraphQueries: (ds, on) => {
        const entry = { ds, on };
        listeners.push(entry);
        return () => listeners.splice(listeners.indexOf(entry), 1);
      },
      syncOntologiesRouted: async (options) => {
        calls.push(`routed ${options.orphanScope}`);
        const emit = (ds: unknown, graph: string) =>
          listeners.filter((l) => l.ds === ds).forEach((l) => l.on({ kind: 'graph_create', graph }, Promise.resolve()));
        emit(main, GA);
        emit(main, GB);
        emit(two, GB);
        return {
          targets: [
            { dataset: 'Store "main"', result: { written: ['x-a', 'x-b'], skipped: [], pruned: [], target: 'package' } },
            { dataset: 'Store "two"', result: { written: ['x-b'], skipped: [], pruned: [], target: 'package' } },
          ],
          pruned: [],
          leftovers: [],
          failed,
        };
      },
      checkShapeHierarchy: async () => {
        calls.push('check');
        return [];
      },
      loadOntologyHierarchy: async () => {
        calls.push('hierarchy');
      },
    };
    return { core, calls, listeners };
  }

  it('a pinned package is written into both datasets; one line names them; every dataset is observed', async () => {
    const { core, calls, listeners } = routedCore();
    const lines: string[] = [];
    const result = await runOntologyPhase({ id: 'main' }, { core, sync: true, routed: true, orphanScope: 'none', log: (m) => lines.push(m), warn: () => {} });
    expect(calls).toEqual(['routed none', 'check']);
    expect(listeners).toEqual([]);
    expect(result.ontologies).toEqual({
      written: ['x-a', 'x-b'],
      skipped: [],
      graphs: [GA, GB],
      droppedGraphs: [],
      datasets: ['Store "main"', 'Store "two"'],
      prunedGraphs: [],
      leftovers: [],
    });
    expect(lines).toEqual([
      `[LinkedServer] ontology sync: written x-a, x-b; graphs written ${GA}, ${GB}; datasets Store "main", Store "two"`,
    ]);
  });

  it('a failed dataset is the phase failure; the hierarchy is set and the check runs', async () => {
    const { core, calls } = routedCore([{ dataset: 'Store "two"', error: 'down' }]);
    const result = await runOntologyPhase({ id: 'main' }, { core, sync: true, routed: true, orphanScope: 'none', log: () => {}, warn: () => {} });
    expect(result.failure?.message).toBe('the ontology sync failed in Store "two": down');
    expect(calls).toEqual(['routed none', 'check']);
  });
});
