// A linked package is imported whole at boot only when it has a JavaScript entry: a pure-CSS
// package such as @_linked/css has none, and importing it fails "Failed to resolve entry".
import {hasModuleEntry} from '../utils/linkedDependencies';

describe('hasModuleEntry', () => {
  test('main or module is an entry', () => {
    expect(hasModuleEntry({main: 'lib/index.js'})).toBe(true);
    expect(hasModuleEntry({module: 'lib/esm/index.js'})).toBe(true);
  });

  test('an exports string, a root entry, or a conditions-only map is an entry', () => {
    expect(hasModuleEntry({exports: './lib/index.js'})).toBe(true);
    expect(hasModuleEntry({exports: {'.': './lib/index.js', './x': './x.js'}})).toBe(true);
    expect(hasModuleEntry({exports: {import: './lib/esm/index.js'}})).toBe(true);
  });

  test('a pure-CSS package has no entry', () => {
    expect(hasModuleEntry({name: '@_linked/css', linkedPackage: true})).toBe(false);
    expect(hasModuleEntry({exports: {'./*.css': './src/*.css'}})).toBe(false);
    expect(hasModuleEntry(undefined)).toBe(false);
  });
});
