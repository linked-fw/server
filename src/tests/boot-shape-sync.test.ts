import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  appShapesGraph,
  bootOrphanScope,
  readShapesTurtle,
  shapeTurtleSource,
  syncShapeGraphsInto,
  viteShapesTurtleGenerator,
  type ShapeGraphCore,
  type ShapeGraphSyncResult,
} from '../utils/syncShapes.js';

/**
 * A stand-in for core's shape graph sync: records the options, asks `turtleFor` for every package
 * it covers (as core does), and answers with `result`.
 */
function fakeCore(registered: string[], result: Partial<ShapeGraphSyncResult> = {}) {
  const calls: Array<{ ds: unknown; options: any; turtles: Record<string, string | undefined> }> = [];
  const core: ShapeGraphCore = {
    packagesWithShapes: () => registered,
    shapesGraphFor: (name) => `https://linked.cm/pkg/${name.replace(/^@_linked\//, '')}/graph/shapes`,
    syncShapeGraphs: async (ds, options) => {
      const turtles: Record<string, string | undefined> = {};
      for (const name of registered) {
        if (options.packages && !options.packages.includes(name)) continue;
        turtles[name] = await options.turtleFor(name);
      }
      calls.push({ ds, options, turtles });
      return { written: [], skipped: [], pruned: [], cleaned: 0, ...result };
    },
  };
  return { core, calls };
}

const quiet = { log: () => {}, warn: () => {} };

describe('bootOrphanScope', () => {
  it("is 'none' when LINKED_SYNC_SHAPES_PRUNE_ORPHANS is unset", () => {
    expect(bootOrphanScope({})).toBe('none');
  });

  it("is 'all' only for the exact string 'true'", () => {
    expect(bootOrphanScope({ LINKED_SYNC_SHAPES_PRUNE_ORPHANS: 'true' })).toBe('all');
    for (const v of ['false', 'TRUE', '1', 'yes', '']) {
      expect(bootOrphanScope({ LINKED_SYNC_SHAPES_PRUNE_ORPHANS: v })).toBe('none');
    }
  });
});

describe('shapeTurtleSource', () => {
  const file = () => 'TTL';
  const none = () => undefined;

  it('an installed package uses its shapes.ttl, and without one gets none (no generation)', () => {
    expect(shapeTurtleSource('dep', { own: false, dev: false, packageDir: '/d', read: file })).toEqual({ source: 'file', text: 'TTL' });
    expect(shapeTurtleSource('dep', { own: false, dev: true, packageDir: '/d', read: file })).toEqual({ source: 'file', text: 'TTL' });
    expect(shapeTurtleSource('dep', { own: false, dev: false, packageDir: '/d', read: none })).toEqual({ source: 'none' });
    expect(shapeTurtleSource('dep', { own: false, dev: true, packageDir: undefined, read: none })).toEqual({ source: 'none' });
  });

  it('an own package is generated in dev, even with a built file', () => {
    expect(shapeTurtleSource('app', { own: true, dev: true, packageDir: '/a', read: file })).toEqual({ source: 'generated' });
  });

  it('an own package in a built app uses its file, else is generated', () => {
    expect(shapeTurtleSource('app', { own: true, dev: false, packageDir: '/a', read: file })).toEqual({ source: 'file', text: 'TTL' });
    expect(shapeTurtleSource('app', { own: true, dev: false, packageDir: '/a', read: none })).toEqual({ source: 'generated' });
  });
});

describe('readShapesTurtle', () => {
  it('reads lib/esm/data/shapes.ttl of a package root, undefined without it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shapes-ttl-'));
    try {
      expect(readShapesTurtle(dir)).toBeUndefined();
      expect(readShapesTurtle(undefined)).toBeUndefined();
      fs.mkdirSync(path.join(dir, 'lib/esm/data'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lib/esm/data/shapes.ttl'), '<a> <b> <c> .\n');
      expect(readShapesTurtle(dir)).toBe('<a> <b> <c> .\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('appShapesGraph', () => {
  it('is {DATA_ROOT}/graph/shapes', () => {
    expect(appShapesGraph({ DATA_ROOT: 'https://create.now/data' })).toBe('https://create.now/data/graph/shapes');
    expect(appShapesGraph({ DATA_ROOT: 'https://shop.id.create.now/' })).toBe('https://shop.id.create.now/graph/shapes');
  });

  it('is undefined without an absolute DATA_ROOT', () => {
    expect(appShapesGraph({})).toBeUndefined();
    expect(appShapesGraph({ DATA_ROOT: '' })).toBeUndefined();
    expect(appShapesGraph({ DATA_ROOT: 'data' })).toBeUndefined();
  });
});

describe('viteShapesTurtleGenerator', () => {
  it("imports core's packageShapesTurtle through ssrLoadModule, bound to Vite", async () => {
    const loaded: string[] = [];
    const vite = {
      marker: 'vite',
      ssrLoadModule(this: any, url: string) {
        loaded.push(`${this.marker}:${url}`);
        return Promise.resolve({ packageShapesTurtle: (name: string) => `TTL of ${name}` });
      },
    };
    const generate = viteShapesTurtleGenerator(vite)!;
    expect(await generate('app')).toBe('TTL of app');
    expect(loaded).toEqual(['vite:@_linked/core/shapes/shapesToTurtle']);
  });

  it('is undefined without Vite', () => {
    expect(viteShapesTurtleGenerator(undefined)).toBeUndefined();
    expect(viteShapesTurtleGenerator({} as any)).toBeUndefined();
  });
});

describe('syncShapeGraphsInto', () => {
  const dirs: Record<string, string> = { dep: '/n/dep', bare: '/n/bare', app: '/app' };
  const files: Record<string, string> = { '/n/dep': 'DEP TTL', '/app': 'BUILT APP TTL' };
  const base = {
    orphanScope: 'none' as const,
    isOwn: (name: string) => name === 'app',
    packageDirOf: (name: string) => dirs[name],
    read: (dir: string | undefined) => (dir ? files[dir] : undefined),
  };

  it('passes installed files and dev-generated own Turtle, and leaves a package without shapes.ttl out', async () => {
    const { core, calls } = fakeCore(['app', 'bare', 'dep'], { written: ['app', 'dep'], appGraph: 'written' });
    const report = await syncShapeGraphsInto({ name: 'ds' }, {
      ...base,
      core,
      dev: true,
      generate: async (name) => `GENERATED ${name}`,
      appGraph: 'https://app.test/data/graph/shapes',
      appPackage: 'app',
      ...quiet,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].ds).toEqual({ name: 'ds' });
    expect(calls[0].options.packages).toEqual(['app', 'dep']);
    expect(calls[0].options.orphanScope).toBe('none');
    expect(calls[0].options.appShapes).toEqual({ graph: 'https://app.test/data/graph/shapes', package: 'app' });
    expect(calls[0].turtles).toEqual({ app: 'GENERATED app', dep: 'DEP TTL' });
    expect(report).toEqual({
      written: ['app', 'dep'],
      skipped: [],
      pruned: [],
      graphs: [
        'https://linked.cm/pkg/app/graph/shapes',
        'https://linked.cm/pkg/dep/graph/shapes',
        'https://app.test/data/graph/shapes',
      ],
      appGraph: { graph: 'https://app.test/data/graph/shapes', status: 'written' },
      withoutTurtle: ['bare'],
      cleaned: 0,
    });
  });

  it('in a built app, an own package uses its built file', async () => {
    const { core, calls } = fakeCore(['app', 'dep']);
    await syncShapeGraphsInto({}, { ...base, core, dev: false, generate: async () => 'NEVER', ...quiet });
    expect(calls[0].turtles).toEqual({ app: 'BUILT APP TTL', dep: 'DEP TTL' });
    // Every registered package has Turtle: no filter, so core's orphan pruning can run.
    expect(calls[0].options.packages).toBeUndefined();
    expect(calls[0].options.appShapes).toBeUndefined();
  });

  it("leaves generation to the sync's core when there is no dev loader or it fails", async () => {
    const { core, calls } = fakeCore(['app']);
    const warnings: string[] = [];
    await syncShapeGraphsInto({}, {
      ...base,
      core,
      dev: true,
      generate: async () => {
        throw new Error('loader down');
      },
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(calls[0].turtles).toEqual({ app: undefined });
    expect(warnings.join('\n')).toContain('generating the shapes of app through the dev loader failed');
  });

  it('lists an own package whose generation produced nothing as without Turtle, with a warning', async () => {
    // The dev loader fails and the sync's core holds no shapes for the package: core neither
    // writes nor skips it.
    const { core } = fakeCore(['app', 'dep'], { written: ['dep'] });
    const warnings: string[] = [];
    const lines: string[] = [];
    const report = await syncShapeGraphsInto({}, {
      ...base,
      core,
      dev: true,
      generate: async () => {
        throw new Error('loader down');
      },
      log: (m) => lines.push(m),
      warn: (m) => warnings.push(m),
    });
    expect(report.written).toEqual(['dep']);
    expect(report.skipped).toEqual([]);
    expect(report.withoutTurtle).toEqual(['app']);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toBe('[LinkedServer] no shapes could be generated for app, so it has no shape graph this sync');
    expect(lines[0]).toContain('no shapes.ttl (no shape graph): app');
  });

  it('does not flag packages after the default-graph sync, which reports none', async () => {
    const { core } = fakeCore(['app', 'dep'], { defaultGraph: 4 });
    const warnings: string[] = [];
    const report = await syncShapeGraphsInto({}, { ...base, core, dev: false, log: () => {}, warn: (m) => warnings.push(m) });
    expect(report.withoutTurtle).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('logs one line with the graphs written, the skipped packages and those without shapes.ttl', async () => {
    const { core } = fakeCore(['app', 'bare', 'dep'], {
      written: ['dep'],
      skipped: ['app'],
      cleaned: 3,
      appGraph: 'skipped',
    });
    const lines: string[] = [];
    await syncShapeGraphsInto({}, {
      ...base,
      core,
      dev: true,
      appGraph: 'https://app.test/data/graph/shapes',
      log: (m) => lines.push(m),
      warn: () => {},
    });
    expect(lines).toEqual([
      '[LinkedServer] shape graph sync: written dep; skipped app; app graph skipped; ' +
        'graphs written https://linked.cm/pkg/dep/graph/shapes; 3 default-graph shape(s) removed; ' +
        'no shapes.ttl (no shape graph): bare',
    ]);
  });

  it('a second run that skips everything logs no graphs written', async () => {
    const { core } = fakeCore(['dep'], { skipped: ['dep'], appGraph: 'skipped' });
    const lines: string[] = [];
    const report = await syncShapeGraphsInto({}, {
      ...base,
      core,
      dev: false,
      appGraph: 'https://app.test/data/graph/shapes',
      log: (m) => lines.push(m),
    });
    expect(report.graphs).toEqual([]);
    expect(lines).toEqual(['[LinkedServer] shape graph sync: written none; skipped dep; app graph skipped']);
  });

  it('reports the default-graph sync of a store without graph queries', async () => {
    const { core } = fakeCore(['dep'], { defaultGraph: 7 });
    const lines: string[] = [];
    const report = await syncShapeGraphsInto({}, { ...base, core, dev: false, log: (m) => lines.push(m) });
    expect(report.defaultGraph).toBe(7);
    expect(lines).toEqual(['[LinkedServer] shape sync (default graph: the store has no graph queries): 7 shape(s) written']);
  });

  it("passes orphanScope 'all', and warns that pruning is skipped while a package has no shapes.ttl", async () => {
    const { core, calls } = fakeCore(['bare', 'dep'], { written: ['dep'], pruned: [] });
    const warnings: string[] = [];
    await syncShapeGraphsInto({}, { ...base, orphanScope: 'all', core, dev: false, log: () => {}, warn: (m) => warnings.push(m) });
    expect(calls[0].options.orphanScope).toBe('all');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not pruned');
  });

  it('throws when the sync fails', async () => {
    const core: ShapeGraphCore = {
      packagesWithShapes: () => [],
      shapesGraphFor: (n) => n,
      syncShapeGraphs: async () => {
        throw new Error('store down');
      },
    };
    await expect(syncShapeGraphsInto({}, { ...base, core, dev: false, ...quiet })).rejects.toThrow('store down');
  });
});
