// What a package.json is comes from its `linked.kind` alone (`linkedKind`, the twin of the
// CLI's): the boot walk loads the kinds that are not `app`, and reads no retired flag.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverLinkedDependencies,
  isLinkedPackageJson,
  LINKED_KINDS,
  linkedKind,
} from '../utils/linkedDependencies';

describe('linkedKind', () => {
  test.each(LINKED_KINDS)('reads linked.kind "%s"', (kind) => {
    expect(linkedKind({ name: 'x', linked: { kind } })).toBe(kind);
  });

  test.each([
    ['no linked object', { name: 'x' }],
    ['a non-string kind', { linked: { kind: 1 } }],
    ['an unknown kind', { linked: { kind: 'package' } }],
    ['the old linkedPackage flag alone', { name: 'x', linkedPackage: true }],
    ['the old linkedApp flag alone', { name: 'x', linkedApp: true }],
    ['null', null],
  ])('undefined for %s', (_label, json) => {
    expect(linkedKind(json)).toBeUndefined();
  });

  test('a linked package is a named package of any kind but app', () => {
    expect(isLinkedPackageJson({ name: 'x', linked: { serverOnly: [], kind: 'library' } })).toBe(true);
    expect(isLinkedPackageJson({ name: 'x', linked: { kind: 'app' } })).toBe(false);
    expect(isLinkedPackageJson({ linked: { kind: 'ontology' } })).toBe(false);
    expect(isLinkedPackageJson({ name: 'x', linkedPackage: true })).toBe(false);
  });
});

describe('discoverLinkedDependencies', () => {
  let appDir: string;
  const install = (name: string, json: object) => {
    const dir = path.join(appDir, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...json }));
  };

  beforeEach(() => {
    appDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-kind-walk-')));
    install('kind-pkg', { linked: { kind: 'ontology' } });
    install('old-flag', { linkedPackage: true });
  });
  afterEach(() => fs.rmSync(appDir, { recursive: true, force: true }));

  const app = { name: 'app', dependencies: { 'kind-pkg': '1', 'old-flag': '1' } };
  const names = (deps: { packageName: string }[]) => deps.map((d) => d.packageName).sort();

  test('finds the packages with a linked.kind only', () => {
    expect(names(discoverLinkedDependencies(appDir, app))).toEqual(['kind-pkg']);
  });

  test('a caller may decide what is linked', () => {
    const either = (json: any) => isLinkedPackageJson(json) || json?.linkedPackage === true;
    expect(names(discoverLinkedDependencies(appDir, app, either))).toEqual(['kind-pkg', 'old-flag']);
  });
});
