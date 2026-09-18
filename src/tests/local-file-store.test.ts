import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
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
let store: any;

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

    const stat = await store.statFile('stat-me.txt');

    expect(stat).not.toBeNull();
    expect(stat.size).toBe(Buffer.byteLength(contents));
    // hashed independently of the implementation
    expect(stat.sha256).toBe(
      createHash('sha256').update(Buffer.from(contents)).digest('hex')
    );
  });

  it('returns null for a file that does not exist', async () => {
    expect(await store.statFile('nothing-here.txt')).toBeNull();
  });

  it('stats a file that saveFile just wrote, by its stored name', async () => {
    const contents = 'saved and verified';
    await store.saveFile('verify-me.txt', Buffer.from(contents), {
      mimeType: 'text/plain',
      preventDuplicates: false,
    });

    const stat = await store.statFile('verify-me.txt');

    expect(stat.size).toBe(Buffer.byteLength(contents));
    expect(stat.sha256).toBe(
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
