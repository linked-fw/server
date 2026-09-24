import { beforeEach, describe, expect, it } from '@jest/globals';
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { FileStorePurposes } from '@_linked/core/utils/LinkedFileStorage';
import type { IFileStore } from '@_linked/core/interfaces/IFileStore';
import { LinkedServer } from '../shapes/LinkedServer.js';

/**
 * `/resized/*` against an SVG source.
 *
 * Sharp can READ svg but has no svg encoder, so both halves of this route used
 * to throw on one: the store-backed branch asked for `.toFormat('svg')`, and
 * the uploads branch called `.toBuffer()` with no explicit format, which
 * defaults to the input's. Both rasterize to PNG now.
 *
 * The assertions are on the BYTES and on the KEY, not on the status code. A
 * status assertion would miss the half of this that matters: writing PNG bytes
 * under a `.svg` key still "works" right up until the cache is hit, at which
 * point the response is typed `image/svg+xml` from that extension and the
 * browser refuses it.
 */

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
    '<rect width="20" height="20" fill="red"/></svg>'
);

const ACCESS_URL = 'http://cdn.test';

/** PNG's 8-byte signature. */
const isPng = (b: Buffer) =>
  b.length > 8 && b.subarray(0, 4).toString('latin1') === '\x89PNG';

class MemoryStore implements IFileStore {
  readonly accessURL = ACCESS_URL;
  files = new Map<string, Buffer>();
  saved: { key: string; bytes: Buffer }[] = [];

  async init() {}
  async fileExists(p: string) {
    return this.files.has(p);
  }
  async getFile(p: string) {
    return this.files.get(p) ?? null;
  }
  async listFiles() {
    return [...this.files.keys()];
  }
  async deleteFile(p: string) {
    this.files.delete(p);
  }
  async saveFile(p: string, content: any) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    this.files.set(p, bytes);
    this.saved.push({ key: p, bytes });
    return `${ACCESS_URL}/${p}`;
  }
}

function makeServer(): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.resizePathsMap = new Map();
  return server;
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    redirectedTo: undefined as any,
    contentType: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body: any) {
      res.body = body;
      return res;
    },
    type(t: string) {
      res.contentType = t;
      return res;
    },
    redirect(to: string) {
      res.redirectedTo = to;
    },
  };
  return res;
}

let store: MemoryStore;

beforeEach(() => {
  (LinkedFileStorage as any).resetForTests?.();
  store = new MemoryStore();
  LinkedFileStorage.setDefaultStore(store);
});

describe('GET /resized/* with an SVG source', () => {
  it('rasterizes to PNG and caches it under a .png key — src branch', async () => {
    store.files.set('logo.svg', SVG);
    const server = makeServer();
    const res = makeRes();

    await server.resizeImage(
      {
        query: { w: '10', src: `${ACCESS_URL}/logo.svg` },
        originalUrl: '/resized/logo.svg?w=10',
      },
      res
    );

    expect(res.statusCode).toBe(200);
    const written = store.saved.find((s) => s.key.includes('resized'));
    expect(written).toBeDefined();
    // The derivative is a PNG...
    expect(isPng(written!.bytes)).toBe(true);
    // ...and the key says so, or the cache-hit path serves it as image/svg+xml.
    expect(written!.key.endsWith('.png')).toBe(true);
    expect(written!.key.endsWith('.svg')).toBe(false);
  });

  it('rasterizes to PNG and caches it under a .png key — uploads branch', async () => {
    LinkedFileStorage.setStore(FileStorePurposes.uploads, store as any);
    store.files.set('logo.svg', SVG);
    const server = makeServer();
    const res = makeRes();

    await server.resizeImage(
      { query: { w: '10' }, originalUrl: '/resized/logo.svg?w=10' },
      res
    );

    const written = store.saved.find((s) => s.key.includes('resized'));
    expect(written).toBeDefined();
    expect(isPng(written!.bytes)).toBe(true);
    expect(written!.key.endsWith('.png')).toBe(true);
  });

  it('leaves a non-SVG source in its own format', async () => {
    // Guards the rasterization from becoming unconditional: a PNG in must not
    // be re-keyed, and a JPEG must stay a JPEG.
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .jpeg()
      .toBuffer();
    store.files.set('photo.jpeg', jpeg);
    LinkedFileStorage.setStore(FileStorePurposes.uploads, store as any);

    const server = makeServer();
    const res = makeRes();
    await server.resizeImage(
      { query: { w: '10' }, originalUrl: '/resized/photo.jpeg?w=10' },
      res
    );

    const written = store.saved.find((s) => s.key.includes('resized'));
    expect(written).toBeDefined();
    expect(written!.key.endsWith('.jpeg')).toBe(true);
    expect(isPng(written!.bytes)).toBe(false);
  });
});
