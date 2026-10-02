import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveBackendEntry } from '../utils/linkedDependencies.js';

let root: string;
const touch = (rel: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export {};\n');
  return file;
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-backend-entry-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('resolveBackendEntry', () => {
  it('an exact ./backend key wins over a pattern', () => {
    const exact = touch('dist/server.js');
    touch('lib/esm/backend.js');
    const json = {
      exports: {
        './*': './lib/esm/*.js',
        './backend': './dist/server.js',
      },
    };
    expect(resolveBackendEntry(root, json)).toBe(exact);
  });

  it('expands the most specific matching ./* pattern', () => {
    const file = touch('lib/esm/backend.js');
    const json = {
      exports: {
        './data/*.json': './lib/esm/data/*.json',
        './*.js': { types: './lib/esm/*.d.ts', import: './lib/esm/*.js' },
        './*': { types: './lib/esm/*.d.ts', import: './lib/esm/*.js' },
        './back*': './nope/*.js',
      },
    };
    // `./back*` has the longer prefix, so it is the one Node would use.
    expect(resolveBackendEntry(root, json)).toBeNull();
    delete (json.exports as any)['./back*'];
    expect(resolveBackendEntry(root, json)).toBe(file);
  });

  it('a pattern pointing at a file that does not exist is no backend', () => {
    // The rdfs case: `./*` exists, lib/esm/backend.js does not.
    touch('lib/esm/index.js');
    expect(
      resolveBackendEntry(root, { exports: { './*': { import: './lib/esm/*.js' } } })
    ).toBeNull();
  });

  it('picks conditions in key order; ignores development and types unless asked', () => {
    const src = touch('src/backend.ts');
    const lib = touch('lib/esm/backend.js');
    const json = {
      exports: {
        './backend': {
          types: './lib/esm/backend.d.ts',
          development: './src/backend.ts',
          node: { import: './lib/esm/backend.js' },
          default: './nope.js',
        },
      },
    };
    expect(resolveBackendEntry(root, json)).toBe(lib);
    expect(resolveBackendEntry(root, json, ['development', 'import', 'node', 'default'])).toBe(
      src
    );
    // `default` alone.
    expect(
      resolveBackendEntry(root, { exports: { './backend': { default: './lib/esm/backend.js' } } })
    ).toBe(lib);
    // Only a `require` target: not loadable by import().
    expect(
      resolveBackendEntry(root, { exports: { './backend': { require: './lib/esm/backend.js' } } })
    ).toBeNull();
  });

  it('exports without ./backend (and sugar for ".") mean no backend', () => {
    touch('lib/esm/backend.js');
    expect(resolveBackendEntry(root, { exports: { '.': './lib/esm/index.js' } })).toBeNull();
    expect(resolveBackendEntry(root, { exports: './lib/esm/index.js' })).toBeNull();
    expect(resolveBackendEntry(root, { exports: { import: './lib/esm/index.js' } })).toBeNull();
  });

  it('never resolves outside the package', () => {
    fs.writeFileSync(path.join(path.dirname(root), 'escape.js'), '');
    expect(resolveBackendEntry(root, { exports: { './backend': './../escape.js' } })).toBeNull();
    fs.rmSync(path.join(path.dirname(root), 'escape.js'));
  });

  it('without exports: backend.js, then a backend.js next to main, then lib/esm', () => {
    expect(resolveBackendEntry(root, {})).toBeNull();
    const esm = touch('lib/esm/backend.js');
    expect(resolveBackendEntry(root, {})).toBe(esm);
    const nextToMain = touch('dist/backend.js');
    expect(resolveBackendEntry(root, { main: 'dist/index.js' })).toBe(nextToMain);
    const top = touch('backend.js');
    expect(resolveBackendEntry(root, { main: 'dist/index.js' })).toBe(top);
  });
});
