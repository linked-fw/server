import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import * as path from 'path';
import type { AddressInfo } from 'net';
import {
  AdminRequestError,
  assertReloadablePackages,
  isValidPackageName,
  parseGraphContentBody,
  registerAdminRoutes,
  type GraphContentAnswer,
} from '../utils/adminChannel.js';
import { invalidateSourceUnder } from '../utils/reloadSource.js';
import { envMs, withTimeout } from '../utils/withTimeout.js';

const SECRET = 's3cret-s3cret';
const servers: any[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

type GraphContentRequest = { packages?: string[]; reload: string[] };

const answer = (reloaded: string[] = []): GraphContentAnswer => ({
  graphTargets: { ontologyGraph: 'package', shapeGraph: 'package' },
  packages: [],
  withoutTurtle: [],
  unreadable: [],
  reloaded,
});

async function serve(
  secret: string | undefined,
  graphContent: (r: GraphContentRequest) => Promise<GraphContentAnswer> = async () => answer(),
  exit: () => void = () => {}
): Promise<string> {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app, secret, { exit, graphContent });
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, route: string, body: unknown, secret: string | null = SECRET) =>
  fetch(`${base}/admin/${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-app-admin-secret': secret }),
    },
    body: JSON.stringify(body),
  });

describe('admin channel', () => {
  it('has no sync-shapes route: it answers 404, with and without the secret', async () => {
    const base = await serve(SECRET);
    expect((await post(base, 'sync-shapes', {})).status).toBe(404);
    expect((await post(base, 'sync-shapes', { packages: ['my-assets'] })).status).toBe(404);
    expect((await post(base, 'sync-shapes', {}, null)).status).toBe(404);
  });

  it('passes graph-content its reload list and answers what it answers', async () => {
    const calls: GraphContentRequest[] = [];
    const base = await serve(SECRET, async (r) => {
      calls.push(r);
      return answer(r.reload);
    });
    const res = await post(base, 'graph-content', { reload: ['my-assets', 'my-assets'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer(['my-assets']));
    expect(calls).toEqual([{ reload: ['my-assets'] }]);
  });

  it('runs graph-content without a reload for an empty body', async () => {
    const calls: GraphContentRequest[] = [];
    const base = await serve(SECRET, async (r) => {
      calls.push(r);
      return answer();
    });
    const res = await fetch(`${base}/admin/graph-content`, {
      method: 'POST',
      headers: { 'x-app-admin-secret': SECRET },
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ reload: [] }]);
  });

  it('answers 500 with the reason when graph-content fails', async () => {
    const base = await serve(SECRET, async () => {
      throw new Error('the graph content did not finish within 120000 ms');
    });
    const res = await post(base, 'graph-content', {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'the graph content did not finish within 120000 ms' });
  });

  it('answers 400 for an unknown package and for a malformed body', async () => {
    const base = await serve(SECRET, async (r) => {
      throw new AdminRequestError(`unknown package: ${r.reload[0]}`);
    });
    const unknown = await post(base, 'graph-content', { reload: ['nope'] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'unknown package: nope' });
    const malformed = await post(base, 'graph-content', { reload: 'nope' });
    expect(malformed.status).toBe(400);
  });

  it('refuses a wrong or missing secret with 401 and never runs', async () => {
    let ran = 0;
    const base = await serve(SECRET, async () => {
      ran++;
      return answer();
    });
    expect((await post(base, 'graph-content', {}, 'wrong-secret!')).status).toBe(401);
    expect((await post(base, 'graph-content', {}, null)).status).toBe(401);
    expect(ran).toBe(0);
  });

  it('reads only x-app-admin-secret: a wrong one, or the secret under another header, is 401', async () => {
    let ran = 0;
    const base = await serve(SECRET, async () => {
      ran++;
      return answer();
    });
    const res = await fetch(`${base}/admin/graph-content`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-app-admin-secret': 'wrong-secret!',
        'x-cn-admin-secret': SECRET,
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(ran).toBe(0);
  });

  it('is absent (404) without a configured secret', async () => {
    const base = await serve(undefined);
    expect((await post(base, 'graph-content', {})).status).toBe(404);
    expect((await fetch(`${base}/admin/health`)).status).toBe(404);
  });

  it('keeps health and restart', async () => {
    let exited = 0;
    const base = await serve(SECRET, undefined, () => exited++);
    const health = await fetch(`${base}/admin/health`, { headers: { 'x-app-admin-secret': SECRET } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    const restart = await fetch(`${base}/admin/restart`, {
      method: 'POST',
      headers: { 'x-app-admin-secret': SECRET },
    });
    expect(restart.status).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect(exited).toBe(1);
  });
});

describe('parseGraphContentBody', () => {
  it('accepts no body, an empty object and lists of names', () => {
    expect(parseGraphContentBody(undefined)).toEqual({ reload: [] });
    expect(parseGraphContentBody({})).toEqual({ reload: [] });
    expect(parseGraphContentBody({ reload: ['a', 'b'] })).toEqual({ reload: ['a', 'b'] });
  });

  it('refuses anything else', () => {
    expect(() => parseGraphContentBody('x')).toThrow(AdminRequestError);
    expect(() => parseGraphContentBody({ reload: [1] })).toThrow(AdminRequestError);
    expect(() => parseGraphContentBody({ reload: [''] })).toThrow(AdminRequestError);
  });
});

describe('invalidateSourceUnder', () => {
  const root = path.resolve('/app/packages/my-assets');
  const graph = (files: Array<string | null>) => {
    const changed: string[] = [];
    return {
      changed,
      idToModuleMap: new Map(files.map((file, i) => [`id${i}`, { file }])),
      onFileChange: (file: string) => changed.push(file),
    };
  };

  it("invalidates the package's source modules once each, and nothing else", () => {
    const barrel = path.join(root, 'src/shapes/index.ts');
    const entry = path.join(root, 'src/backend.ts');
    const g = graph([
      barrel,
      entry,
      barrel,
      path.join(root, 'node_modules/dep/index.js'),
      path.resolve('/app/packages/my-assets-other/src/index.ts'),
      path.resolve('/app/src/backend.ts'),
      null,
    ]);
    expect(invalidateSourceUnder(g, [root]).sort()).toEqual([entry, barrel].sort());
    expect(g.changed.sort()).toEqual([entry, barrel].sort());
  });
});

describe('package names a host may ask to reload', () => {
  it('accepts npm package names and refuses paths and junk', () => {
    for (const ok of ['my-assets', '@acme/my-app', 'a.b_c~d']) expect(isValidPackageName(ok)).toBe(true);
    for (const bad of ['..', '../x', 'a/../b', '@acme/..', '/abs', 'Upper', '.hidden', '_x', 'a b', '@x', ''])
      expect(isValidPackageName(bad)).toBe(false);
  });

  it('the body parser refuses a name that is not a package name', () => {
    expect(() => parseGraphContentBody({ reload: ['../../etc'] })).toThrow(AdminRequestError);
  });

  it('allows only the app and its direct dependencies, never @_linked/*', () => {
    const allowed = new Set(['app', 'app-assets', '@_linked/core']);
    expect(() => assertReloadablePackages(['app', 'app-assets'], allowed)).not.toThrow();
    expect(() => assertReloadablePackages(['@_linked/core'], allowed)).toThrow(/framework packages/);
    expect(() => assertReloadablePackages(['other'], allowed)).toThrow(/neither the app nor one of its direct dependencies/);
    expect(() => assertReloadablePackages(['..'], allowed)).toThrow(/not a package name/);
  });
});

describe('withTimeout', () => {
  it('passes a result through and rejects a hung operation with the message', async () => {
    await expect(withTimeout(Promise.resolve(3), 50, 'slow')).resolves.toBe(3);
    await expect(withTimeout(new Promise(() => {}), 20, 'the sync did not finish')).rejects.toThrow('the sync did not finish');
  });

  it('a queue built on it is released after a timeout', async () => {
    let queue: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(op: () => Promise<T>) => {
      const run = queue.then(() => withTimeout(op(), 20, 'timed out'));
      queue = run.catch(() => undefined);
      return run;
    };
    await expect(enqueue(() => new Promise(() => {}))).rejects.toThrow('timed out');
    await expect(enqueue(async () => 'next')).resolves.toBe('next');
  });

  it('envMs reads a positive number, else the fallback', () => {
    expect(envMs('X', 5, { X: '100' })).toBe(100);
    expect(envMs('X', 5, { X: 'abc' })).toBe(5);
    expect(envMs('X', 5, {})).toBe(5);
  });
});
