import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import * as path from 'path';
import type { AddressInfo } from 'net';
import {
  AdminRequestError,
  parseSyncShapesBody,
  registerAdminRoutes,
  type ShapeSyncResult,
} from '../utils/adminChannel.js';
import { invalidateSourceUnder } from '../utils/reloadSource.js';

const SECRET = 's3cret-s3cret';
const servers: any[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(
  secret: string | undefined,
  syncShapes: (r: { packages: string[] }) => Promise<ShapeSyncResult>,
  exit: () => void = () => {}
): Promise<string> {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app, secret, { exit, syncShapes });
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, body: unknown, secret: string | null = SECRET) =>
  fetch(`${base}/admin/sync-shapes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-cn-admin-secret': secret }),
    },
    body: JSON.stringify(body),
  });

describe('admin channel: sync-shapes', () => {
  it('runs the sync with the named packages and answers its result', async () => {
    const calls: Array<{ packages: string[] }> = [];
    const base = await serve(SECRET, async (r) => {
      calls.push(r);
      return { written: 2, orphanScope: 'none' };
    });
    const res = await post(base, { packages: ['my-assets', 'my-assets'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: 2, orphanScope: 'none' });
    expect(calls).toEqual([{ packages: ['my-assets'] }]);
  });

  it('runs a sync without packages for an empty body', async () => {
    const calls: Array<{ packages: string[] }> = [];
    const base = await serve(SECRET, async (r) => {
      calls.push(r);
      return { written: 0, orphanScope: 'none' };
    });
    const res = await fetch(`${base}/admin/sync-shapes`, {
      method: 'POST',
      headers: { 'x-cn-admin-secret': SECRET },
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ packages: [] }]);
  });

  it('answers 500 with the reason when the sync fails', async () => {
    const base = await serve(SECRET, async () => {
      throw new Error('data server answered 503');
    });
    const res = await post(base, {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'data server answered 503' });
  });

  it('answers 400 for an unknown package and for a malformed body', async () => {
    const base = await serve(SECRET, async (r) => {
      throw new AdminRequestError(`unknown package: ${r.packages[0]}`);
    });
    const unknown = await post(base, { packages: ['nope'] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'unknown package: nope' });
    const malformed = await post(base, { packages: 'nope' });
    expect(malformed.status).toBe(400);
  });

  it('refuses a wrong or missing secret with 401 and never syncs', async () => {
    let ran = 0;
    const base = await serve(SECRET, async () => {
      ran++;
      return { written: 0 };
    });
    expect((await post(base, {}, 'wrong-secret!')).status).toBe(401);
    expect((await post(base, {}, null)).status).toBe(401);
    expect(ran).toBe(0);
  });

  it('is absent (404) without a configured secret', async () => {
    const base = await serve(undefined, async () => ({ written: 0 }));
    expect((await post(base, {})).status).toBe(404);
    expect((await fetch(`${base}/admin/health`)).status).toBe(404);
  });

  it('keeps health and restart', async () => {
    let exited = 0;
    const base = await serve(SECRET, async () => ({ written: 0 }), () => exited++);
    const health = await fetch(`${base}/admin/health`, { headers: { 'x-cn-admin-secret': SECRET } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    const restart = await fetch(`${base}/admin/restart`, {
      method: 'POST',
      headers: { 'x-cn-admin-secret': SECRET },
    });
    expect(restart.status).toBe(202);
    await new Promise((r) => setTimeout(r, 100));
    expect(exited).toBe(1);
  });
});

describe('parseSyncShapesBody', () => {
  it('accepts no body, an empty object and a list of names', () => {
    expect(parseSyncShapesBody(undefined)).toEqual({ packages: [] });
    expect(parseSyncShapesBody({})).toEqual({ packages: [] });
    expect(parseSyncShapesBody({ packages: ['a', 'b'] })).toEqual({ packages: ['a', 'b'] });
  });

  it('refuses anything else', () => {
    expect(() => parseSyncShapesBody('x')).toThrow(AdminRequestError);
    expect(() => parseSyncShapesBody({ packages: [1] })).toThrow(AdminRequestError);
    expect(() => parseSyncShapesBody({ packages: [''] })).toThrow(AdminRequestError);
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
