import { describe, expect, it } from '@jest/globals';
import { bootOrphanScope, materializeShapes } from '../utils/syncShapes.js';

// A stand-in for core `syncShapes` that records the options it was called with
// and hands back one thunk per "registered shape".
function fakeSync(shapeCount = 3) {
  const seen: Array<{ ds: unknown; options: unknown }> = [];
  let ran = 0;
  const fn = async (ds: unknown, options: any) => {
    seen.push({ ds, options });
    return Array.from({ length: shapeCount }, () => async () => {
      ran++;
    });
  };
  return { fn, seen, ran: () => ran };
}

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

describe('materializeShapes (boot sync)', () => {
  it("passes orphanScope 'none' explicitly by default — never relies on core's default", async () => {
    const sync = fakeSync();
    const ds = { name: 'app-data' };
    const result = await materializeShapes(ds, sync.fn, { env: {}, log: () => {} });
    expect(sync.seen).toEqual([{ ds, options: { orphanScope: 'none' } }]);
    expect(result).toEqual({ count: 3, orphanScope: 'none' });
    expect(sync.ran()).toBe(3);
  });

  it("passes orphanScope 'all' when the operator opts in", async () => {
    const sync = fakeSync();
    await materializeShapes({}, sync.fn, {
      env: { LINKED_SYNC_SHAPES_PRUNE_ORPHANS: 'true' },
      log: () => {},
    });
    expect(sync.seen[0].options).toEqual({ orphanScope: 'all' });
  });

  it('runs every thunk, in batches', async () => {
    const sync = fakeSync(20);
    await materializeShapes({}, sync.fn, { env: {}, log: () => {} });
    expect(sync.ran()).toBe(20);
  });

  it('logs exactly one line, naming the mode that ran', async () => {
    const lines: string[] = [];
    await materializeShapes({}, fakeSync().fn, { env: {}, log: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("orphanScope 'none'");

    const pruneLines: string[] = [];
    await materializeShapes({}, fakeSync().fn, {
      env: { LINKED_SYNC_SHAPES_PRUNE_ORPHANS: 'true' },
      log: (m) => pruneLines.push(m),
    });
    expect(pruneLines).toHaveLength(1);
    expect(pruneLines[0]).toContain("orphanScope 'all'");
  });
});
