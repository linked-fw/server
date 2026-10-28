// The packages an app lists in `linked.unpublishedPackages` (localized into `packages-local/`)
// are its direct dependencies, transitively: boot loading finds them, the reload check allows
// them, and the shape check's dependency lists name them.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverLinkedDependencies,
  findListedPackage,
  listedPackageNames,
  readDependencyLists,
  unpublishedNames,
} from '../utils/linkedDependencies';
import { assertReloadablePackages } from '../utils/adminChannel';

const listing = (...names: string[]) => ({
  unpublishedPackages: Object.fromEntries(
    names.map((n) => [n, { repo: `https://github.com/org/${n}.git` }])
  ),
});

describe('linked.unpublishedPackages as direct dependencies', () => {
  let appDir: string;

  /** A checkout in packages-local/<dir>; `linked` also links it into node_modules, as npm does. */
  const checkout = (name: string, json: object, linked = true) => {
    const dir = path.join(appDir, 'packages-local', name.replace('/', '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...json }));
    if (linked) {
      const link = path.join(appDir, 'node_modules', name);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(dir, link, 'dir');
    }
    return fs.realpathSync(dir);
  };
  const install = (name: string, json: object) => {
    const dir = path.join(appDir, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...json }));
  };
  const names = (deps: { packageName: string }[]) => deps.map((d) => d.packageName);

  beforeEach(() => {
    appDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unpublished-walk-')));
  });
  afterEach(() => fs.rmSync(appDir, { recursive: true, force: true }));

  test('an app list names its packages; no list names none', () => {
    expect(unpublishedNames({ linked: listing('a-ont', 'a-assets') })).toEqual(['a-ont', 'a-assets']);
    expect(unpublishedNames({ name: 'x' })).toEqual([]);
    expect(unpublishedNames(null)).toEqual([]);
  });

  test('a malformed list is an error, never skipped', () => {
    expect(() => unpublishedNames({ linked: { unpublishedPackages: ['a-ont'] } })).toThrow(/not an object/);
    expect(() => unpublishedNames({ linked: { unpublishedPackages: { 'a-ont': {} } } })).toThrow(/needs/);
  });

  test('boot discovery loads a listed package from its workspace link', () => {
    const dir = checkout('a-ont', { linked: { kind: 'ontology' } });
    const found = discoverLinkedDependencies(appDir, { name: 'app', linked: listing('a-ont') });
    expect(names(found)).toEqual(['a-ont']);
    expect(found[0].path).toBe(dir);
  });

  test('a checkout npm has not linked yet is found by npm name in packages-local', () => {
    const dir = checkout('@ws/a-ont', { linked: { kind: 'ontology' } }, false);
    expect(findListedPackage('@ws/a-ont', appDir, appDir)?.root).toBe(dir);
    expect(names(discoverLinkedDependencies(appDir, { name: 'app', linked: listing('@ws/a-ont') }))).toEqual([
      '@ws/a-ont',
    ]);
  });

  test('lists are followed transitively, each package after the ones it lists', () => {
    checkout('a-ont', { linked: { kind: 'ontology' } });
    checkout('a-assets', { linked: { kind: 'assets', ...listing('a-ont') } });
    const app = { name: 'app', linked: { kind: 'app', ...listing('a-assets') } };
    expect(names(discoverLinkedDependencies(appDir, app))).toEqual(['a-ont', 'a-assets']);
    expect([...listedPackageNames(appDir, app)].sort()).toEqual(['a-assets', 'a-ont']);
  });

  test('a listed package also counts after the published dependencies it shares', () => {
    install('lib', { linked: { kind: 'library' } });
    checkout('a-ont', { linked: { kind: 'ontology' }, dependencies: { lib: '1' } });
    const app = { name: 'app', dependencies: { lib: '1' }, linked: listing('a-ont') };
    expect(names(discoverLinkedDependencies(appDir, app))).toEqual(['lib', 'a-ont']);
  });

  test('a listed package without a checkout is not loaded, but is still a direct dependency', () => {
    checkout('a-ont', { linked: { kind: 'ontology' } });
    const app = { name: 'app', linked: listing('a-ont', 'gone-assets') };
    expect(names(discoverLinkedDependencies(appDir, app))).toEqual(['a-ont']);
    expect(findListedPackage('gone-assets', appDir, appDir)).toBeNull();
    const allowed = new Set(['app', ...listedPackageNames(appDir, app)]);
    expect(() => assertReloadablePackages(['a-ont', 'gone-assets'], allowed)).not.toThrow();
    expect(() => assertReloadablePackages(['other-ont'], allowed)).toThrow(/linked.unpublishedPackages/);
  });

  test('a listed package without linked.kind is not loaded', () => {
    checkout('plain', {});
    expect(discoverLinkedDependencies(appDir, { name: 'app', linked: listing('plain') })).toEqual([]);
  });

  test('the shape check reads each list as dependencies', () => {
    const assets = checkout('a-assets', { linked: { kind: 'assets', ...listing('a-ont') }, dependencies: { lib: '1' } });
    const lists = readDependencyLists([['a-assets', assets]], { name: 'app', linked: listing('a-assets') });
    expect(lists).toEqual({ app: ['a-assets'], 'a-assets': ['a-ont', 'lib'] });
  });
});
