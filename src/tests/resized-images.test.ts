import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'net';
import sharp from 'sharp';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import type { IFileStore } from '@_linked/core/interfaces/IFileStore';
import { LinkedServer } from '../shapes/LinkedServer.js';

// `GET /resized/*` is registered before the `apiOnly` guard, so it is live on
// every deployment, and it is the only route in the server that touches sharp.
// The bump to sharp ^0.35 (a semver-major) had no test behind it, so these
// exercise the real encoder on both of the handler's branches:
//
//  - the REMOTE branch: `?src=<url>` is fetched with `globalThis.fetch`,
//    resized in memory and written to LinkedFileStorage, with the resulting CDN
//    URL cached both in-process (`resizePathsMap`) and in the store itself;
//  - the LOCAL branch: the path after `/resized/` is read from
//    `<cwd>/data/uploads`, resized, and cached as a file in
//    `<cwd>/data/uploads/resized` which is then sent back.
//
// Every fixture is generated with sharp at run time — no binary files in git.
// `globalThis.fetch` is replaced per test, never called for real, so the suite
// stays offline; `realFetch` is kept aside for the test client itself.

const realFetch = globalThis.fetch;
const CDN = 'https://cdn.example.test';

const servers: any[] = [];
let tmpDir: string;
let cwdBefore: string;

/** A file store that keeps everything in memory, so saves are observable. */
class MemoryFileStore implements IFileStore {
  public readonly accessURL = CDN;
  public readonly files = new Map<string, Buffer>();

  private key(filePath: string) {
    return filePath.startsWith('/') ? filePath.slice(1) : filePath;
  }

  async saveFile(filePath: string, fileContent: any): Promise<string> {
    const key = this.key(filePath);
    this.files.set(key, Buffer.from(fileContent));
    return `${this.accessURL}/${key}`;
  }

  async fileExists(filePath: string): Promise<boolean> {
    return this.files.has(this.key(filePath));
  }

  async getFile(filePath: string): Promise<Buffer | null> {
    return this.files.get(this.key(filePath)) ?? null;
  }

  async deleteFile(filePath: string): Promise<void> {
    this.files.delete(this.key(filePath));
  }

  async listFiles(prefix?: string): Promise<string[]> {
    const keys = [...this.files.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
}

let store: MemoryFileStore;

/**
 * A LinkedServer with only the fields `resizeImage` touches — the same trick
 * call-errors/call-semantics use to exercise one handler without booting the
 * whole server (which would need a package index, vite, providers, …).
 */
function makeLinkedServer(): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.resizePathsMap = new Map();
  return server;
}

/** Mirrors the registration in `LinkedServer.setup()`. */
async function listen(linkedServer: any): Promise<string> {
  const app = express();
  app.get('/resized/*', async (req, res) => {
    linkedServer.resizeImage(req, res);
  });
  const s = await new Promise<any>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** Never follows redirects: the handler answers with 302s that we assert on. */
async function get(base: string, url: string) {
  const res = await realFetch(base + url, { redirect: 'manual' });
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    location: res.headers.get('location'),
    buffer,
    json: () => JSON.parse(buffer.toString('utf-8')),
  };
}

/** A deterministic, non-uniform test image, so encoders have real work to do. */
async function makeImage(
  format: 'jpeg' | 'png' | 'webp',
  width = 120,
  height = 90
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 120, b: 220 },
    },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: Math.round(width / 2),
            height: Math.round(height / 2),
            channels: 3,
            background: { r: 240, g: 30, b: 90 },
          },
        })
          .png()
          .toBuffer(),
        top: 0,
        left: 0,
      },
    ])
    .toFormat(format)
    .toBuffer();
}

/** Stub `globalThis.fetch` for the handler's remote branch. */
function stubFetch(impl: (url: string) => Promise<any>) {
  const calls: string[] = [];
  (globalThis as any).fetch = (url: any, ...rest: any[]) => {
    calls.push(String(url));
    return impl(String(url));
  };
  return calls;
}

function okResponse(body: Buffer) {
  // Shaped like the parts of a Response the handler reads: `ok`, a `headers`
  // lookup for content-length, and `arrayBuffer`. No `body` stream, so the
  // size cap falls back to measuring the buffered result.
  return Promise.resolve({
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
}

/**
 * Put a source image in the store under the key `?src=<CDN>/uploads/<name>`
 * resolves to.
 *
 * The route only fetches images it already stores, so a remote-branch test has
 * to seed the source first. Before that guard existed these tests passed with
 * an empty store, which is exactly the hole it closes.
 */
function seedSource(fileName: string, body: Buffer) {
  store.files.set(`uploads/${fileName}`, body);
}

beforeAll(async () => {
  cwdBefore = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resized-images-'));
  // The local branch resolves `data/uploads` against the CWD, so the whole file
  // runs from a scratch directory rather than writing into the repo.
  await fs.mkdir(path.join(tmpDir, 'data', 'uploads', 'resized'), {
    recursive: true,
  });
  process.chdir(tmpDir);
});

afterAll(async () => {
  process.chdir(cwdBefore);
  await fs.rm(tmpDir, { recursive: true, force: true });
  (globalThis as any).fetch = realFetch;
  LinkedFileStorage.resetForTests();
});

beforeEach(() => {
  store = new MemoryFileStore();
  LinkedFileStorage.resetForTests();
  LinkedFileStorage.setDefaultStore(store);
});

afterEach(async () => {
  (globalThis as any).fetch = realFetch;
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe('/resized/* — no dimensions given', () => {
  it('redirects to the untouched original under /uploads', async () => {
    const base = await listen(makeLinkedServer());
    const res = await get(base, '/resized/photo.jpg');
    expect(res.status).toBe(302);
    expect(res.location).toBe('/uploads/photo.jpg');
  });
});

describe('/resized/* — remote branch (?src=)', () => {
  it('resizes a fetched jpeg and stores it under a dimension-tagged key', async () => {
    const original = await makeImage('jpeg');
    seedSource('photo.jpg', original);
    const calls = stubFetch(() => okResponse(original));
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/photo.jpg`)}&w=60`
    );

    expect(calls).toEqual([`${CDN}/uploads/photo.jpg`]);
    expect(res.status).toBe(302);
    expect(res.location).toBe(`${CDN}/uploads/resized/photo_w60.jpg`);

    const saved = await store.getFile('uploads/resized/photo_w60.jpg');
    expect(saved).not.toBeNull();
    const meta = await sharp(saved!).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(60);
    // Aspect ratio preserved: 120x90 scaled to width 60.
    expect(meta.height).toBe(45);
  });

  it('scales by height alone, tagging the key with `h` only', async () => {
    const original = await makeImage('png');
    seedSource('logo.png', original);
    stubFetch(() => okResponse(original));
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/logo.png`)}&h=30`
    );

    // The separator is emitted once, before either dimension, so a height-only
    // key reads `logo_h30`. It used to live inside the width segment, which gave
    // `logoh30` here while the local branch produced `logo_h30` for the same
    // request -- the two halves of one route disagreeing on the cache key.
    expect(res.location).toBe(`${CDN}/uploads/resized/logo_h30.png`);
    const meta = await sharp(
      (await store.getFile('uploads/resized/logo_h30.png'))!
    ).metadata();
    expect(meta.format).toBe('png');
    expect(meta.height).toBe(30);
    expect(meta.width).toBe(40);
  });

  it('honours both dimensions, cropping to the exact box', async () => {
    const original = await makeImage('webp');
    seedSource('banner.webp', original);
    stubFetch(() => okResponse(original));
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/banner.webp`)}&w=50&h=50`
    );

    expect(res.location).toBe(`${CDN}/uploads/resized/banner_w50h50.webp`);
    const meta = await sharp(
      (await store.getFile('uploads/resized/banner_w50h50.webp'))!
    ).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  // The output options are the part a sharp major could silently change. Each
  // case re-encodes the same source with the options the handler is supposed to
  // pass and asserts byte-for-byte equality — and that the encoder's own
  // default would have produced something different, so the assertion has teeth.
  const outputOptionCases: Array<
    [
      format: 'jpeg' | 'png' | 'webp',
      fileName: string,
      options: Record<string, number>,
      /** What sharp encodes with when the handler passes nothing special. */
      defaults: Record<string, number>,
    ]
  > = [
    ['jpeg', 'photo.jpg', { quality: 90 }, {}],
    ['png', 'logo.png', { compressionLevel: 9 }, { compressionLevel: 6 }],
    ['webp', 'banner.webp', { quality: 90 }, {}],
  ];

  it.each(outputOptionCases)(
    'applies the %s output options the handler selects',
    async (format, fileName, options, defaults) => {
      const original = await makeImage(format);
      seedSource(fileName, original);
      stubFetch(() => okResponse(original));
      const base = await listen(makeLinkedServer());

      await get(
        base,
        `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/${fileName}`)}&w=60`
      );

      const key = `uploads/resized/${fileName.replace(/\.(\w+)$/, '_w60.$1')}`;
      const saved = await store.getFile(key);

      const expected = await sharp(original)
        .resize(60, null)
        .toFormat(format, options)
        .toBuffer();
      expect(saved!.equals(expected)).toBe(true);

      const withDefaults = await sharp(original)
        .resize(60, null)
        .toFormat(format, defaults)
        .toBuffer();
      expect(saved!.equals(withDefaults)).toBe(false);
    }
  );

  it('serves a second request for the same size from the in-process map', async () => {
    const original = await makeImage('jpeg');
    seedSource('photo.jpg', original);
    const calls = stubFetch(() => okResponse(original));
    const linkedServer = makeLinkedServer();
    const base = await listen(linkedServer);
    const url = `/resized/x?src=${encodeURIComponent(
      `${CDN}/uploads/photo.jpg`
    )}&w=60`;

    const first = await get(base, url);
    const second = await get(base, url);

    expect(second.status).toBe(302);
    expect(second.location).toBe(first.location);
    // Cached: the source is fetched and re-encoded exactly once.
    expect(calls).toHaveLength(1);
    expect(linkedServer.resizePathsMap.get('uploads/resized/photo_w60.jpg')).toBe(
      first.location
    );
  });

  it('reuses a resize another process already wrote to the store', async () => {
    // A cold process with an empty map must still not re-encode: the store is
    // consulted before the source is fetched.
    await store.saveFile(
      'uploads/resized/photo_w60.jpg',
      await makeImage('jpeg', 60, 45)
    );
    seedSource('photo.jpg', await makeImage('jpeg'));
    const calls = stubFetch(() => okResponse(Buffer.alloc(0)));
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/photo.jpg`)}&w=60`
    );

    expect(res.status).toBe(302);
    expect(res.location).toBe(`${CDN}/uploads/resized/photo_w60.jpg`);
    expect(calls).toHaveLength(0);
  });

  it('answers 404 when the source cannot be fetched', async () => {
    stubFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/gone.jpg`)}&w=60`
    );

    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'Could not fetch image from URL' });
  });

  it('answers 400 when the fetched bytes are not a supported image', async () => {
    seedSource('page.jpg', Buffer.from('<html>not an image</html>'));
    stubFetch(() => okResponse(Buffer.from('<html>not an image</html>')));
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/page.jpg`)}&w=60`
    );

    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: 'Unsupported image format' });
    // the source itself is in the store (it has to be, to get past the guard);
    // what must not happen is a resized output being written from junk bytes
    expect([...store.files.keys()].filter((k) => k.includes('resized/'))).toEqual(
      []
    );
  });
});

describe('/resized/* — local branch (uploads folder)', () => {
  const uploads = () => path.join(process.cwd(), 'data', 'uploads');

  // A real LocalFileStore, not the in-memory stand-in: this branch reads the
  // original and writes the derivative through LinkedFileStorage now, and the
  // assertions below are about where those land on disk. With the default
  // basePath that is `<cwd>/data/uploads`, so writing a fixture with fs is the
  // same thing as putting it in the store.
  beforeEach(async () => {
    const { LocalFileStore } = await import(
      '../shapes/filestores/LocalFileStore.js'
    );
    process.env.SITE_ROOT = 'http://localhost:4000';
    LinkedFileStorage.resetForTests();
    LinkedFileStorage.setDefaultStore(new LocalFileStore('resize-local-branch'));
  });

  /** Fails the request loudly if the handler reaches for the network. */
  function forbidFetch() {
    (globalThis as any).fetch = () => {
      throw new Error('the local branch must not fetch');
    };
  }

  it('resizes a local upload, caches it on disk and sends it back', async () => {
    forbidFetch();
    await fs.writeFile(
      path.join(uploads(), 'local.jpg'),
      await makeImage('jpeg')
    );
    const base = await listen(makeLinkedServer());

    const res = await get(base, '/resized/local.jpg?w=40');

    expect(res.status).toBe(200);
    const meta = await sharp(res.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(30);

    // The cache file is written under the dimension-tagged name…
    const cached = path.join(uploads(), 'resized', 'local_w40.jpg');
    expect((await fs.readFile(cached)).equals(res.buffer)).toBe(true);
  });

  it('serves the cached file without touching the original again', async () => {
    forbidFetch();
    await fs.writeFile(
      path.join(uploads(), 'cached.png'),
      await makeImage('png')
    );
    const base = await listen(makeLinkedServer());

    const first = await get(base, '/resized/cached.png?h=45');
    expect(first.status).toBe(200);

    // Removing the source proves the second response comes off disk.
    await fs.rm(path.join(uploads(), 'cached.png'));
    const second = await get(base, '/resized/cached.png?h=45');

    expect(second.status).toBe(200);
    expect(second.buffer.equals(first.buffer)).toBe(true);
    expect(
      (await sharp(second.buffer).metadata()).height
    ).toBe(45);
  });

  it('keeps separate cache entries per requested size', async () => {
    forbidFetch();
    await fs.writeFile(
      path.join(uploads(), 'sizes.webp'),
      await makeImage('webp')
    );
    const base = await listen(makeLinkedServer());

    await get(base, '/resized/sizes.webp?w=30');
    await get(base, '/resized/sizes.webp?w=30&h=30');

    const written = (await fs.readdir(path.join(uploads(), 'resized'))).filter(
      (f) => f.startsWith('sizes')
    );
    expect(written.sort()).toEqual(['sizes_w30.webp', 'sizes_w30h30.webp']);
  });

  it('answers 404 when the original upload does not exist', async () => {
    forbidFetch();
    const base = await listen(makeLinkedServer());

    const res = await get(base, '/resized/missing.jpg?w=40');

    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'Could not find original image' });
  });
});

// The guard the route exists behind now. Before it, `?src=` went straight to
// fetch(), so any unauthenticated caller could aim the server at cloud
// metadata, localhost or a private range -- and the bytes were written into the
// PUBLIC store and handed back as a URL, so a reachable internal resource was
// persisted rather than merely leaked.
describe('/resized/* — only fetches images the store already holds', () => {
  const refused: Array<[label: string, src: string]> = [
    ['cloud metadata', 'http://169.254.169.254/metadata/v1.json'],
    ['loopback', 'http://localhost:3030/$/datasets'],
    ['a private range', 'http://10.0.0.7/private-diagram.png'],
    ['an unrelated host', 'https://attacker.test/payload.png'],
    // the classic startsWith() bypass: a prefix match on the CDN origin passes,
    // an origin comparison does not
    ['a lookalike host', `${CDN}.evil.test/uploads/photo.jpg`],
    // credentials are ignored by URL.origin, so they are refused separately
    ['embedded credentials', 'https://user:pw@cdn.example.test/uploads/photo.jpg'],
    ['a scheme downgrade', 'http://cdn.example.test/uploads/photo.jpg'],
  ];

  it.each(refused)('refuses %s without making a request', async (_label, src) => {
    const calls = stubFetch(() => {
      throw new Error('the guard must refuse before any fetch');
    });
    const base = await listen(makeLinkedServer());

    const res = await get(base, `/resized/x?src=${encodeURIComponent(src)}&w=60`);

    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: 'Unsupported image source' });
    // the point of the fix: nothing left the process
    expect(calls).toEqual([]);
    expect(store.files.size).toBe(0);
  });

  it('refuses a well-formed store URL for a file the store does not hold', async () => {
    const calls = stubFetch(() => {
      throw new Error('the guard must refuse before any fetch');
    });
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/never-uploaded.jpg`)}&w=60`
    );

    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'Could not fetch image from URL' });
    expect(calls).toEqual([]);
  });

  it('fetches the URL it rebuilt, not the string the caller sent', async () => {
    // same key, but with a fragment and a redundantly encoded segment; the
    // handler must normalise to the canonical store URL before fetching
    const original = await makeImage('jpeg');
    seedSource('photo.jpg', original);
    const calls = stubFetch(() => okResponse(original));
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/photo.jpg#fragment`)}&w=60`
    );

    expect(res.status).toBe(302);
    expect(calls).toEqual([`${CDN}/uploads/photo.jpg`]);
  });

  it('refuses redirects, so an allowed origin cannot hop elsewhere', async () => {
    const original = await makeImage('jpeg');
    seedSource('photo.jpg', original);
    let sawRedirectOption: string | undefined;
    (globalThis as any).fetch = (_url: any, init: any) => {
      sawRedirectOption = init?.redirect;
      return okResponse(original);
    };
    const base = await listen(makeLinkedServer());

    await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/photo.jpg`)}&w=60`
    );

    // fetch follows redirects by default, which would undo the origin check one
    // hop later
    expect(sawRedirectOption).toBe('error');
  });

  it('refuses a response larger than the cap', async () => {
    seedSource('huge.jpg', Buffer.alloc(1));
    (globalThis as any).fetch = () =>
      Promise.resolve({
        ok: true,
        headers: { get: () => String(64 * 1024 * 1024) },
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(`${CDN}/uploads/huge.jpg`)}&w=60`
    );

    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'Could not fetch image from URL' });
  });
});

// Regression guard for a real LocalFileStore, not the in-memory stand-in.
//
// The two stores do not agree on how a public URL maps back to a key:
// S3FileStore serves a key directly under accessURL, while LocalFileStore
// serves `accessURL + /uploads/ + key`. The first version of the source guard
// derived one key from the URL and only ever ran against a MemoryFileStore
// shaped like S3, so it passed while every LocalFileStore deployment 404'd.
describe('/resized/* — key shape against a real LocalFileStore', () => {
  let localStore: any;
  let localDir: string;
  let cwdBeforeLocal: string;

  beforeEach(async () => {
    cwdBeforeLocal = process.cwd();
    localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resized-localstore-'));
    await fs.mkdir(path.join(localDir, 'data', 'uploads'), { recursive: true });
    process.chdir(localDir);

    process.env.SITE_ROOT = 'http://localhost:4000';
    const { LocalFileStore } = await import(
      '../shapes/filestores/LocalFileStore.js'
    );
    localStore = new LocalFileStore('resize-local');
    LinkedFileStorage.resetForTests();
    LinkedFileStorage.setDefaultStore(localStore);
  });

  afterEach(async () => {
    process.chdir(cwdBeforeLocal);
    await fs.rm(localDir, { recursive: true, force: true });
  });

  it('resolves a LocalFileStore public URL back to its key', async () => {
    const original = await makeImage('jpeg');
    // the store decides both the key and the URL it is served under
    const saved = await localStore.saveFileWithPath(
      'photo.jpg',
      original,
      { mimeType: 'image/jpeg', preventDuplicates: false }
    );

    // the key has no `uploads/` segment, the URL does -- the whole point
    expect(saved.storedPath).toBe('photo.jpg');
    expect(saved.publicURL).toBe('http://localhost:4000/uploads/photo.jpg');

    stubFetch(() => okResponse(original));
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(saved.publicURL)}&w=60`
    );

    // before the fix this was 404: fileExists('uploads/photo.jpg') is false
    expect(res.status).toBe(302);
    const meta = await sharp(
      (await localStore.getFile('resized/photo_w60.jpg'))!
    ).metadata();
    expect(meta.width).toBe(60);
  });

  it('still refuses a LocalFileStore URL for a file that is not stored', async () => {
    const calls = stubFetch(() => {
      throw new Error('the guard must refuse before any fetch');
    });
    const base = await listen(makeLinkedServer());

    const res = await get(
      base,
      `/resized/x?src=${encodeURIComponent(
        'http://localhost:4000/uploads/never-stored.jpg'
      )}&w=60`
    );

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

// The bug this branch had for as long as it existed: it read and wrote
// <cwd>/data/uploads directly, so an app whose uploads live in S3 had nothing
// on local disk and every request 404'd. MemoryFileStore stands in for any
// non-local store here — what matters is that it is not the filesystem.
describe('/resized/* — local branch works for a non-local store', () => {
  beforeEach(() => {
    (globalThis as any).fetch = () => {
      throw new Error('the local branch must not fetch');
    };
  });

  it('resizes an upload the store holds, with nothing on disk', async () => {
    store.files.set('remote-only.jpg', await makeImage('jpeg'));
    const base = await listen(makeLinkedServer());

    const res = await get(base, '/resized/remote-only.jpg?w=40');

    expect(res.status).toBe(200);
    expect((await sharp(res.buffer).metadata()).width).toBe(40);
    // the derivative went to the store, not to a folder
    expect(store.files.has('resized/remote-only_w40.jpg')).toBe(true);
    await expect(
      fs.stat(path.join(process.cwd(), 'data', 'uploads', 'remote-only.jpg'))
    ).rejects.toThrow();
  });

  it('serves the second request from the store without resizing again', async () => {
    store.files.set('twice.jpg', await makeImage('jpeg'));
    const base = await listen(makeLinkedServer());

    const first = await get(base, '/resized/twice.jpg?w=40');
    // drop the original: only the cached derivative can answer now
    store.files.delete('twice.jpg');
    const second = await get(base, '/resized/twice.jpg?w=40');

    expect(second.status).toBe(200);
    expect(second.buffer.equals(first.buffer)).toBe(true);
  });

  it('404s when the store does not hold the original', async () => {
    const base = await listen(makeLinkedServer());

    const res = await get(base, '/resized/absent.jpg?w=40');

    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: 'Could not find original image' });
  });

  it('puts derivatives in whichever store the purpose names', async () => {
    // the point of the purpose: originals in one store, cache in another
    const { resizedImagesPurpose } = await import(
      '../utils/resizedImagesPurpose.js'
    );
    const cache = new MemoryFileStore();
    LinkedFileStorage.setStore(resizedImagesPurpose, cache);
    store.files.set('split.jpg', await makeImage('jpeg'));
    const base = await listen(makeLinkedServer());

    const res = await get(base, '/resized/split.jpg?w=40');

    expect(res.status).toBe(200);
    expect(cache.files.has('resized/split_w40.jpg')).toBe(true);
    // the uploads store keeps only the original
    expect([...store.files.keys()]).toEqual(['split.jpg']);
  });
});
