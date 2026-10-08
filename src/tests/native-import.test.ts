import { afterAll, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { LinkedServer } from '../shapes/LinkedServer.js';
import { nativeImport } from '../utils/nativeImport.js';

// An installed package's backend must load through Node's own loader. A dev
// SSR runner that bundles this package rewrites every `import()` it can parse,
// so the loader must not contain one a transform could see.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-native-import-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const importModule = (specifier: string) =>
  (LinkedServer.prototype as any).importModule.call({}, specifier);

describe('importModule', () => {
  it('is built with the Function constructor, so no transform can rewrite it', () => {
    const source = nativeImport.toString();
    expect(source).toMatch(/^function anonymous\(/);
    expect(source).toContain('return import(specifier);');
  });

  it('contains no import() of its own for a transform to rewrite', () => {
    const source = (LinkedServer.prototype as any).importModule.toString();
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).toContain('nativeImport');
  });

  it('returns the one module instance for every load of the same file', async () => {
    const file = path.join(dir, 'backend.mjs');
    fs.writeFileSync(file, 'export const marker = {};\n');
    const url = pathToFileURL(file).href;

    const first = await importModule(url);
    const second = await importModule(url);
    expect(first.marker).toBeDefined();
    expect(second).toBe(first);
    expect(second.marker).toBe(first.marker);
  });
});
