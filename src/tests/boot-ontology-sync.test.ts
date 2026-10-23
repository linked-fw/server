import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bootSyncsOntologies,
  loadOntologyCore,
  ontologyPackageDirs,
  runOntologyPhase,
  sourceModuleImporter,
  shapeSyncOn,
  syncOntologiesThenShapes,
  type OntologyCore,
} from '../utils/ontologySync.js';
import { readDependencyLists } from '../utils/linkedDependencies.js';

type Finding = Awaited<ReturnType<OntologyCore['checkShapeHierarchy']>>[number];

const GA = 'https://linked.cm/pkg/x-a/graph/ontology';

// A stand-in for core's ontology API that records the order of calls.
function fakeCore({
  syncFails = false,
  findings = [] as Finding[],
  withHierarchy = true,
  withRegister = true,
  registerFails = false,
  graphQueries = [{ kind: 'graph_replace', graph: GA }] as Array<{ kind: string; graph: string; fails?: boolean }>,
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
      return { written: ['@x/a'], skipped: ['@x/b'], pruned: [] };
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
  it('follows the shape sync switch', () => {
    expect(shapeSyncOn({}, undefined)).toBe(true);
    expect(shapeSyncOn({}, false)).toBe(false);
    expect(shapeSyncOn({ LINKED_SYNC_SHAPES_ON_BOOT: 'false' }, true)).toBe(false);
    expect(bootSyncsOntologies({})).toBe(true);
    expect(bootSyncsOntologies({}, false)).toBe(false);
    expect(bootSyncsOntologies({ LINKED_SYNC_SHAPES_ON_BOOT: 'false' })).toBe(false);
  });

  it('has its own opt-out, LINKED_SYNC_ONTOLOGIES_ON_BOOT=false, which leaves shape sync on', () => {
    const env = { LINKED_SYNC_ONTOLOGIES_ON_BOOT: 'false' };
    expect(bootSyncsOntologies(env)).toBe(false);
    expect(shapeSyncOn(env, undefined)).toBe(true);
    expect(bootSyncsOntologies({ LINKED_SYNC_ONTOLOGIES_ON_BOOT: 'true' })).toBe(true);
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
      `[LinkedServer] ontology sync: written @x/a; skipped @x/b; graphs written ${GA}`,
      '[LinkedServer] shape check: 1 error(s), 2 warning(s)',
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('error (extends-without-subclass): sC extends sD');
  });
});

describe('syncOntologiesThenShapes (the host re-sync)', () => {
  it('runs the ontology phase, then the shape sync, and merges their results', async () => {
    const order: string[] = [];
    const result = await syncOntologiesThenShapes(
      async () => {
        order.push('ontologies');
        return { ontologies: { written: ['@x/a'], skipped: [] }, shapeCheck: { errors: 0, warnings: 1 } };
      },
      async () => {
        order.push('shapes');
        return { written: 2, orphanScope: 'none' as const };
      }
    );
    expect(order).toEqual(['ontologies', 'shapes']);
    expect(result).toEqual({
      written: 2,
      orphanScope: 'none',
      ontologies: { written: ['@x/a'], skipped: [] },
      shapeCheck: { errors: 0, warnings: 1 },
    });
  });

  it('runs the shape sync after a failed ontology sync, then fails with the ontology error', async () => {
    let shapesRan = false;
    await expect(
      syncOntologiesThenShapes(
        async () => ({
          ontologies: { written: [], skipped: [] },
          shapeCheck: { errors: 0, warnings: 0 },
          failure: new Error('store unreachable'),
        }),
        async () => {
          shapesRan = true;
          return { written: 0 };
        }
      )
    ).rejects.toThrow('store unreachable');
    expect(shapesRan).toBe(true);
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
      `[LinkedServer] ontology sync: written @x/a; skipped @x/b; pruned none; graphs written ${GA}, ${GB}; graphs dropped ${GOLD}`,
    );
    expect(seen.unobserved).toBe(true);
  });

  it('says so when packages were written without a graph query (a store without graph queries)', async () => {
    const { core } = fakeCore({ graphQueries: [] });
    const lines: string[] = [];
    const result = await runOntologyPhase({}, { core, sync: true, orphanScope: 'none', log: (m) => lines.push(m), warn: () => {} });
    expect(result.ontologies).toEqual({ written: ['@x/a'], skipped: ['@x/b'], graphs: [], droppedGraphs: [] });
    expect(lines[0]).toBe(
      '[LinkedServer] ontology sync (default graph: the store has no graph queries): written @x/a; skipped @x/b',
    );
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
