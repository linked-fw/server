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

  it('keeps suffixing names when preventDuplicates is not specified', async () => {
    const publicURL = await store.saveFile(
      'suffixed.txt',
      Buffer.from('suffixed'),
      'text/plain'
    );

    expect(publicURL).toMatch(
      /^http:\/\/localhost:4000\/uploads\/suffixed_[a-z0-9]{6}\.txt$/
    );
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

    // unspecified preventDuplicates: the name gained a suffix, and storedPath
    // is the only place that name is reported
    expect(saved.storedPath).toMatch(/^Round-Trip_[a-z0-9]{6}\.txt$/);
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
// default. A two-argument saveFile() therefore has to keep behaving exactly as
// it did before options existed.
describe('LinkedFileStorage.saveFile through LocalFileStore', () => {
  let LinkedFileStorage: any;

  beforeAll(async () => {
    ({ LinkedFileStorage } = await import(
      '@_linked/core/utils/LinkedFileStorage'
    ));
    LinkedFileStorage.setDefaultStore(store);
  });

  it('suffixes the name when the caller passes no options at all', async () => {
    const first = await LinkedFileStorage.saveFile(
      'two-args.txt',
      Buffer.from('first')
    );
    const second = await LinkedFileStorage.saveFile(
      'two-args.txt',
      Buffer.from('second')
    );

    const suffixed = /^http:\/\/localhost:4000\/uploads\/two-args_[a-z0-9]{6}\.txt$/;
    expect(first).toMatch(suffixed);
    expect(second).toMatch(suffixed);
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
