import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { IFileStore } from '@_linked/core/interfaces/IFileStore';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// getUploadTarget() resolves './data/uploads' against the CURRENT WORKING
// DIRECTORY, and LocalFileStore's default basePath is that same relative path.
// So the whole suite runs from a scratch directory: that is the only way
// saveFile and statFile can be observed against the same real folder without
// writing into the repo.
const UPLOAD_DIR = path.join('data', 'uploads');

let tmpDir: string;
let cwdBefore: string;
// Typed as the interface, not `any`, so a signature regression in saveFile or
// statFile fails the build instead of passing silently. statFile is optional on
// IFileStore, so every call here goes through statFileOf(), which asserts the
// store actually implements it.
let store: IFileStore;

function statFileOf(fileStore: IFileStore) {
  if (!fileStore.statFile) {
    throw new Error('the store under test must implement statFile');
  }
  return fileStore.statFile.bind(fileStore);
}

beforeAll(async () => {
  cwdBefore = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-file-store-'));
  await fs.mkdir(path.join(tmpDir, UPLOAD_DIR), { recursive: true });
  process.chdir(tmpDir);

  process.env.DATA_ROOT = process.env.DATA_ROOT || 'http://localhost/data';
  process.env.SITE_ROOT = 'http://localhost:4000';

  const { LocalFileStore } = await import(
    '../shapes/filestores/LocalFileStore.js'
  );
  store = new LocalFileStore('test-filestore');
});

afterAll(async () => {
  process.chdir(cwdBefore);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('LocalFileStore is not a Shape', () => {
  // Pins the decision from core 0e8c86e ("datasets are not shapes"), so a future
  // refactor cannot silently re-inherit. Shape's instantiation guard is currently
  // deferred naming this class as the reason; re-enabling it requires this to hold.
  it('does not extend Shape', async () => {
    const { Shape } = await import('@_linked/core/shapes/Shape');
    expect(store instanceof Shape).toBe(false);
  });

  it('still satisfies IFileStore', () => {
    for (const method of ['saveFile', 'getFile', 'deleteFile', 'fileExists', 'listFiles']) {
      expect(typeof (store as never as Record<string, unknown>)[method]).toBe('function');
    }
    expect(typeof store.accessURL).toBe('string');
  });
});

async function writeUpload(name: string, contents: string) {
  await fs.writeFile(path.join(tmpDir, UPLOAD_DIR, name), contents);
}

describe('LocalFileStore.statFile', () => {
  it('reports the size and a sha256 of the stored bytes', async () => {
    const contents = 'the quick brown fox\n';
    await writeUpload('stat-me.txt', contents);

    const stat = await statFileOf(store)('stat-me.txt');

    expect(stat).not.toBeNull();
    expect(stat!.size).toBe(Buffer.byteLength(contents));
    // hashed independently of the implementation
    expect(stat!.sha256).toBe(
      createHash('sha256').update(Buffer.from(contents)).digest('hex')
    );
  });

  it('returns null for a file that does not exist', async () => {
    expect(await statFileOf(store)('nothing-here.txt')).toBeNull();
  });

  it('stats a file that saveFile just wrote, by its stored name', async () => {
    const contents = 'saved and verified';
    await store.saveFile('verify-me.txt', Buffer.from(contents), {
      mimeType: 'text/plain',
      preventDuplicates: false,
    });

    const stat = await statFileOf(store)('verify-me.txt');

    expect(stat).not.toBeNull();
    expect(stat!.size).toBe(Buffer.byteLength(contents));
    expect(stat!.sha256).toBe(
      createHash('sha256').update(Buffer.from(contents)).digest('hex')
    );
  });
});

describe('LocalFileStore.saveFile options', () => {
  it('accepts a SaveFileOptions object', async () => {
    const publicURL = await store.saveFile(
      'options-form.txt',
      Buffer.from('options'),
      {
        mimeType: 'text/plain',
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { release: '1.0.0' },
        preventDuplicates: false,
      }
    );

    // cacheControl and metadata are accepted and ignored locally
    expect(publicURL).toBe('http://localhost:4000/uploads/options-form.txt');
    expect(await store.fileExists('options-form.txt')).toBe(true);
  });

  it('still accepts a positional mime-type string', async () => {
    // no extension: the mimeType has to supply one, which only works if the
    // string form is still read as the mime type
    const publicURL = await store.saveFile(
      'positional-form',
      Buffer.from('positional'),
      'text/plain',
      false
    );

    expect(publicURL).toBe(
      'http://localhost:4000/uploads/positional-form.plain'
    );
    expect(await store.fileExists('positional-form.plain')).toBe(true);
  });

  it('keeps a free name as-is when preventDuplicates is not specified', async () => {
    const publicURL = await store.saveFile(
      'suffixed.txt',
      Buffer.from('suffixed'),
      'text/plain'
    );

    expect(publicURL).toBe('http://localhost:4000/uploads/suffixed.txt');
  });

  it('suffixes only once the name is actually taken', async () => {
    const opts = 'text/plain';

    const first = await store.saveFile(
      'taken.txt',
      Buffer.from('first'),
      opts
    );
    const second = await store.saveFile(
      'taken.txt',
      Buffer.from('second'),
      opts
    );

    expect(first).toBe('http://localhost:4000/uploads/taken.txt');
    expect(second).toMatch(
      /^http:\/\/localhost:4000\/uploads\/taken_[a-z0-9]{6}\.txt$/
    );
    // the never-clobber guarantee is what matters: the first file is intact
    expect((await store.getFile('taken.txt'))!.toString()).toBe('first');
  });
});

describe('LocalFileStore key handling', () => {
  it('stores a mixed-case key verbatim and reads it back by that key', async () => {
    // a Vite content hash: lowercasing it would make the asset unfetchable
    const name = 'main-hwqwrAvA.css';
    const contents = 'body{color:red}';

    const publicURL = await store.saveFile(name, Buffer.from(contents), {
      mimeType: 'text/css',
      preventDuplicates: false,
    });

    expect(publicURL).toBe('http://localhost:4000/uploads/main-hwqwrAvA.css');
    expect(await store.fileExists(name)).toBe(true);
    expect((await store.getFile(name))!.toString()).toBe(contents);

    const stat = await statFileOf(store)(name);
    expect(stat).not.toBeNull();
    expect(stat!.sha256).toBe(
      createHash('sha256').update(Buffer.from(contents)).digest('hex')
    );

    // and the bytes really are under the mixed-case name on disk
    const onDisk = await fs.readdir(path.join(tmpDir, UPLOAD_DIR));
    expect(onDisk).toContain(name);
  });

  it('keeps a doubled dash, as a Vite hash starting with one produces', async () => {
    // rollup's default base64 hash alphabet includes '-', so an entry name and
    // a hash that starts with one meet as '--'. Collapsing that run rewrites
    // the key, and the URL baked into the bundle then points at nothing.
    const name = 'shapeCodeGenerator--2JmNvrO.js';

    const publicURL = await store.saveFile(name, Buffer.from('export{}'), {
      mimeType: 'text/javascript',
      preventDuplicates: false,
    });

    expect(publicURL).toBe(`http://localhost:4000/uploads/${name}`);
    expect(await store.fileExists(name)).toBe(true);
  });

  it('preservePath keeps release object keys exactly, including @ and case', async () => {
    const { LocalFileStore } = await import(
      '../shapes/filestores/LocalFileStore.js'
    );
    const saving = store as InstanceType<typeof LocalFileStore>;
    const keys = [
      'releases/1.19.0-local-a/public/images/logo@2x.png',
      'releases/1.19.0-local-a/public/bundles/main-AbC123.js',
      'releases/1.19.0-local-a/public/bundles/assets/Shape--2JmNvrO.js',
    ];

    for (const name of keys) {
      const contents = `bytes-for-${name}`;
      const saved = await saving.saveFileWithPath(name, Buffer.from(contents), {
        mimeType: 'application/octet-stream',
        preventDuplicates: false,
        preservePath: true,
      });

      expect(saved.storedPath).toBe(name);
      expect(saved.publicURL).toBe(`http://localhost:4000/uploads/${name}`);
      expect(await store.fileExists(name)).toBe(true);
      expect((await store.getFile(name))!.toString()).toBe(contents);

      const stat = await statFileOf(store)(name);
      expect(stat).not.toBeNull();
      expect(stat!.size).toBe(Buffer.byteLength(contents));
      expect(stat!.sha256).toBe(
        createHash('sha256').update(Buffer.from(contents)).digest('hex')
      );
    }
  });

  it('rejects unsafe paths when preservePath is true', async () => {
    const unsafe = [
      '',
      '/absolute.txt',
      '../outside.txt',
      'releases/../outside.txt',
      'a/./b.txt',
      'a//b.txt',
      'C:\\outside.txt',
      'C:/outside.txt',
      '\\\\server\\share\\outside.txt',
      'a\\b.txt',
    ];

    for (const filePath of unsafe) {
      await expect(
        store.saveFile(filePath, Buffer.from('nope'), {
          mimeType: 'text/plain',
          preventDuplicates: false,
          preservePath: true,
        })
      ).rejects.toThrow('Cannot preserve unsafe file-store path');
    }
  });

  it('still sanitises @ for ordinary uploads without preservePath', async () => {
    const publicURL = await store.saveFile(
      'logo @2x.png',
      Buffer.from('image'),
      {
        mimeType: 'image/png',
        preventDuplicates: false,
      }
    );

    expect(publicURL).toBe('http://localhost:4000/uploads/logo-2x.png');
    expect(await store.fileExists('logo-2x.png')).toBe(true);
    expect(await store.fileExists('logo @2x.png')).toBe(false);
  });

  it('still replaces characters that are unsafe in a file name', async () => {
    const publicURL = await store.saveFile(
      'My File (2).TXT',
      Buffer.from('sanitised'),
      { mimeType: 'text/plain', preventDuplicates: false }
    );

    expect(publicURL).toBe('http://localhost:4000/uploads/My-File-2-.TXT');
    expect(await store.fileExists('My-File-2-.TXT')).toBe(true);
  });

  it('reports the stored path alongside the URL, suffix included', async () => {
    const { LocalFileStore } = await import(
      '../shapes/filestores/LocalFileStore.js'
    );
    const saving = store as InstanceType<typeof LocalFileStore>;

    const saved = await saving.saveFileWithPath(
      'Round-Trip.txt',
      Buffer.from('round trip')
    );

    // unspecified preventDuplicates on a free name: the key is the one the
    // caller asked for, and storedPath reports it either way
    expect(saved.storedPath).toBe('Round-Trip.txt');
    expect(saved.publicURL).toBe(
      'http://localhost:4000/uploads/' + saved.storedPath
    );
    // the whole point: what saveFile gives you goes straight into statFile
    expect(await statFileOf(store)(saved.storedPath)).not.toBeNull();
    expect((await store.getFile(saved.storedPath))!.toString()).toBe(
      'round trip'
    );
  });

  it('overwrites in place when preventDuplicates is false', async () => {
    const opts = { mimeType: 'text/plain', preventDuplicates: false };

    const first = await store.saveFile(
      'In-Place.txt',
      Buffer.from('first'),
      opts
    );
    const second = await store.saveFile(
      'In-Place.txt',
      Buffer.from('second'),
      opts
    );

    expect(second).toBe(first);
    expect((await store.getFile('In-Place.txt'))!.toString()).toBe('second');
    expect(
      (await fs.readdir(path.join(tmpDir, UPLOAD_DIR))).filter((f) =>
        f.startsWith('In-Place')
      )
    ).toEqual(['In-Place.txt']);
  });
});

describe('LocalFileStore with a custom basePath', () => {
  let customStore: IFileStore;
  let customBase: string;

  beforeAll(async () => {
    const { LocalFileStore } = await import(
      '../shapes/filestores/LocalFileStore.js'
    );
    customBase = path.join(tmpDir, 'my-file-store');
    customStore = new LocalFileStore('custom-filestore', customBase);
  });

  it('writes into the custom folder, not the default upload folder', async () => {
    const contents = 'in the custom folder';

    await customStore.saveFile('Asset-AbC123.js', Buffer.from(contents), {
      mimeType: 'text/javascript',
      preventDuplicates: false,
    });

    // the folder is created on demand
    expect(await fs.readdir(customBase)).toEqual(['Asset-AbC123.js']);
    expect(
      await fs.readFile(path.join(customBase, 'Asset-AbC123.js'), 'utf8')
    ).toBe(contents);
    // and nothing leaked into the default upload folder
    expect(await fs.readdir(path.join(tmpDir, UPLOAD_DIR))).not.toContain(
      'Asset-AbC123.js'
    );
  });

  it('round-trips save -> statFile/getFile/fileExists/deleteFile', async () => {
    const contents = 'round trip in a custom base';
    const { LocalFileStore } = await import(
      '../shapes/filestores/LocalFileStore.js'
    );
    const saved = await (
      customStore as InstanceType<typeof LocalFileStore>
    ).saveFileWithPath('nested/Deep-File.txt', Buffer.from(contents), {
      mimeType: 'text/plain',
      preventDuplicates: false,
    });

    expect(saved.storedPath).toBe('nested/Deep-File.txt');
    expect(await customStore.fileExists(saved.storedPath)).toBe(true);
    expect((await customStore.getFile(saved.storedPath))!.toString()).toBe(
      contents
    );

    const stat = await statFileOf(customStore)(saved.storedPath);
    expect(stat!.size).toBe(Buffer.byteLength(contents));
    expect(stat!.sha256).toBe(
      createHash('sha256').update(Buffer.from(contents)).digest('hex')
    );

    await customStore.deleteFile(saved.storedPath);
    expect(await customStore.fileExists(saved.storedPath)).toBe(false);
    expect(await statFileOf(customStore)(saved.storedPath)).toBeNull();
  });
});

// The end-to-end path: core's LinkedFileStorage forwards an unspecified
// preventDuplicates as undefined, and this store turns that into its own
// default -- protect what is already there, leave a free name alone.
describe('LinkedFileStorage.saveFile through LocalFileStore', () => {
  let LinkedFileStorage: any;

  beforeAll(async () => {
    ({ LinkedFileStorage } = await import(
      '@_linked/core/utils/LinkedFileStorage'
    ));
    LinkedFileStorage.setDefaultStore(store);
  });

  it('protects an existing file when the caller passes no options at all', async () => {
    const first = await LinkedFileStorage.saveFile(
      'two-args.txt',
      Buffer.from('first')
    );
    const second = await LinkedFileStorage.saveFile(
      'two-args.txt',
      Buffer.from('second')
    );

    expect(first).toBe('http://localhost:4000/uploads/two-args.txt');
    expect(second).toMatch(
      /^http:\/\/localhost:4000\/uploads\/two-args_[a-z0-9]{6}\.txt$/
    );
    // the second save must not have overwritten the first
    expect(second).not.toBe(first);

    const nameOf = (url: string) => url.substring(url.lastIndexOf('/') + 1);
    expect(
      await fs.readFile(path.join(tmpDir, UPLOAD_DIR, nameOf(first)), 'utf8')
    ).toBe('first');
    expect(
      await fs.readFile(path.join(tmpDir, UPLOAD_DIR, nameOf(second)), 'utf8')
    ).toBe('second');
  });

  it('overwrites when the caller explicitly sets preventDuplicates to false', async () => {
    const first = await LinkedFileStorage.saveFile(
      'overwrite-me.txt',
      Buffer.from('first'),
      { mimeType: 'text/plain', preventDuplicates: false }
    );
    const second = await LinkedFileStorage.saveFile(
      'overwrite-me.txt',
      Buffer.from('second'),
      { mimeType: 'text/plain', preventDuplicates: false }
    );

    expect(first).toBe('http://localhost:4000/uploads/overwrite-me.txt');
    expect(second).toBe(first);
    expect(
      await fs.readFile(path.join(tmpDir, UPLOAD_DIR, 'overwrite-me.txt'), 'utf8')
    ).toBe('second');
  });
});

// listFiles used to return keys joined onto basePath, which no other method on
// this store accepts, and its recursive branch re-read basePath instead of the
// subdirectory -- so a single folder in the store recursed until the stack blew.
describe('LocalFileStore.listFiles', () => {
  let listStore: IFileStore;
  let listBase: string;

  beforeAll(async () => {
    const { LocalFileStore } = await import(
      '../shapes/filestores/LocalFileStore.js'
    );
    listBase = path.join('data', 'listing');
    await fs.mkdir(path.join(tmpDir, listBase, 'images'), { recursive: true });
    listStore = new LocalFileStore('listing-filestore', listBase);

    const opts = { mimeType: 'text/plain', preventDuplicates: false };
    await listStore.saveFile('root.txt', Buffer.from('root'), opts);
    await listStore.saveFile('images/nested.txt', Buffer.from('nested'), opts);
    await listStore.saveFile('images/other.txt', Buffer.from('other'), opts);
  });

  it('returns keys relative to the base folder, not joined onto it', async () => {
    const keys = await listStore.listFiles();

    expect(keys.sort()).toEqual([
      'images/nested.txt',
      'images/other.txt',
      'root.txt',
    ]);
    // none of them carries the base path
    for (const key of keys) {
      expect(key.startsWith(listBase)).toBe(false);
    }
  });

  it('returns keys that feed straight back into getFile', async () => {
    // the actual regression: a returned key used to double-prefix, so every
    // round trip through getFile missed
    for (const key of await listStore.listFiles()) {
      expect(await listStore.fileExists(key)).toBe(true);
      expect(await listStore.getFile(key)).not.toBeNull();
    }
  });

  it('recurses into a subdirectory instead of re-reading the base folder', async () => {
    // before the fix this never returned: listFiles() found `images`, called
    // itself, read the base folder again, found `images` again, ...
    const keys = await listStore.listFiles();

    expect(keys).toContain('images/nested.txt');
    expect(keys.filter((key) => key === 'images/nested.txt')).toHaveLength(1);
  });

  it('honours the prefix argument, which used to be ignored', async () => {
    expect((await listStore.listFiles('images/')).sort()).toEqual([
      'images/nested.txt',
      'images/other.txt',
    ]);
    expect(await listStore.listFiles('root')).toEqual(['root.txt']);
    expect(await listStore.listFiles('nothing-matches')).toEqual([]);
  });
});
