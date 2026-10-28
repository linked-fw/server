import * as fs from 'fs';
import * as path from 'path';
import { unpublishedPackages } from '@_linked/cli/installed-packages';

/**
 * A linked package found in the app's dependency tree, wherever it is
 * installed: a workspace member, a localized checkout, or a registry install.
 */
export interface LinkedDependency {
  packageName: string;
  /**
   * Realpath of the package root whose backend the server loads: the copy the
   * app itself resolves when that copy is a linked package, otherwise the
   * first copy the walk found.
   */
  path: string;
  /**
   * Every distinct installed copy of this package in the tree (realpaths),
   * in the order the walk found them. More than one means the install is not
   * deduplicated; only `path`'s backend is ever loaded.
   */
  copies: { path: string; version?: string }[];
}

// linkedKind: twin of @_linked/cli src/installed-packages.ts, keep byte-identical.
/** What a `package.json` is, by its `linked.kind`. */
export type LinkedKind = 'app' | 'ontology' | 'assets' | 'library';

/** Every value `linked.kind` may take. */
export const LINKED_KINDS: readonly LinkedKind[] = [
  'app',
  'ontology',
  'assets',
  'library',
];

/**
 * THE way to tell what a `package.json` is: its `"linked": {"kind": …}`. `app` is an app (built
 * by `linked build-app`); `ontology`, `assets` and `library` are linked packages (an ontology
 * package may carry shapes for its own terms; `library` is framework code). Undefined for
 * anything else: no `linked` object and a kind that is not one of these.
 *
 * Until every published package carries `linked.kind`, a `package.json` without one is still
 * read by the retired flags: `linkedApp: true` is an `app`, `linkedPackage: true` a `library`.
 */
export function linkedKind(json: unknown): LinkedKind | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const linked: unknown = (json as {linked?: unknown}).linked;
  if (!linked || typeof linked !== 'object') return retiredFlagKind(json);
  const kind: unknown = (linked as {kind?: unknown}).kind;
  return LINKED_KINDS.find((k) => k === kind) ?? retiredFlagKind(json);
}

/** The kind a `package.json` published before `linked.kind` declares by its retired flags. */
function retiredFlagKind(json: object): LinkedKind | undefined {
  const flags = json as {linkedApp?: unknown; linkedPackage?: unknown};
  if (flags.linkedApp === true) return 'app';
  if (flags.linkedPackage === true) return 'library';
  return undefined;
}
// end of the linkedKind twin.

/**
 * A package whose backend providers the server loads at boot: a named package
 * whose `linked.kind` is not `app` ({@link linkedKind}). That is the only test —
 * not the package's scope. `@_linked/localize` is in the `@_linked` scope and
 * is a CLI tool, not a linked package; a custom-scope package with a kind is
 * a linked package. The CLI's workspace discovery uses the same test.
 *
 * The legacy `"lincd": true` flag is deliberately NOT enough. Those packages
 * import the old `lincd` core, and loading them at boot is what produced
 * "Multiple versions of LINCD are loaded" before boot loading was narrowed to
 * workspace members.
 */
export function isLinkedPackageJson(json: any): boolean {
  if (!json || typeof json.name !== 'string') return false;
  const kind = linkedKind(json);
  return kind !== undefined && kind !== 'app';
}

/**
 * Find an installed package the way Node does: `<dir>/node_modules/<name>`,
 * then each parent directory's `node_modules`. Returns null when it is not
 * installed (an optional dependency, say) rather than throwing.
 */
/**
 * Whether a package has a JavaScript entry the server can import: `main`,
 * `module`, or an `exports` map with a root (`.`) entry or a single string.
 * A linked package can be pure CSS (`@_linked/css`); importing that whole
 * fails with "Failed to resolve entry", so the server skips it.
 */
export function hasModuleEntry(json: any): boolean {
  if (!json) return false;
  if (typeof json.main === 'string' || typeof json.module === 'string') {
    return true;
  }
  const exp = json.exports;
  if (typeof exp === 'string') return true;
  if (exp && typeof exp === 'object') {
    const keys = Object.keys(exp);
    // Conditions only ({import, require, ...}) describe the root entry.
    if (keys.length > 0 && keys.every((k) => !k.startsWith('.'))) return true;
    return '.' in exp;
  }
  return false;
}

export function readInstalledPackage(
  name: string,
  fromDir: string
): { root: string; json: any } | null {
  let dir = path.resolve(fromDir);
  while (true) {
    const root = path.join(dir, 'node_modules', name);
    const pkgJsonPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        return { root, json: JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The npm names a `package.json` lists in `linked.unpublishedPackages` (K-unpublished): packages
 * it uses that are not on npm, localized into the app's `packages-local/`. The server treats them
 * as direct dependencies of whoever lists them. Read with the cli's one reader, so a malformed
 * list throws rather than shrinking silently.
 */
export function unpublishedNames(json: unknown): string[] {
  return unpublishedPackages(json).map((p) => p.name);
}

/** Where a listed package's checkout lives in the app, when npm has not linked it yet. */
const LOCAL_DIR = 'packages-local';

/**
 * A package the app lists in `linked.unpublishedPackages`, found by its npm name: first the
 * way Node finds it (`node_modules/<name>` from `fromDir` up, which is npm's workspace link into
 * `packages-local/` once the app is installed), else among `<appDir>/packages-local/<dir>`
 * by the `name` in each `package.json` (a checkout not yet installed). Null when there is no
 * checkout of it.
 */
export function findListedPackage(
  name: string,
  fromDir: string,
  appDir: string
): { root: string; json: any } | null {
  const installed = readInstalledPackage(name, fromDir);
  if (installed) return installed;
  const localDir = path.join(appDir, LOCAL_DIR);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(localDir).sort();
  } catch {
    return null;
  }
  for (const entry of entries) {
    const root = path.join(localDir, entry);
    try {
      const json = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
      if (json?.name === name) return { root, json };
    } catch {}
  }
  return null;
}

/**
 * Every name in the app's `linked.unpublishedPackages`, and transitively in the lists of the
 * listed packages it finds ({@link findListedPackage}): the packages the server treats as the
 * app's own direct dependencies. A listed package without a checkout still counts; only its own
 * list cannot be read.
 */
export function listedPackageNames(appDir: string, appPackageJson: any): Set<string> {
  const names = new Set<string>();
  const queue = unpublishedNames(appPackageJson).map((name) => ({ name, fromDir: appDir }));
  while (queue.length) {
    const { name, fromDir } = queue.shift()!;
    if (names.has(name) || name === appPackageJson?.name) continue;
    names.add(name);
    const found = findListedPackage(name, fromDir, appDir);
    if (!found) continue;
    const root = realpathOr(found.root);
    for (const next of unpublishedNames(found.json)) queue.push({ name: next, fromDir: root });
  }
  return names;
}

/**
 * Every linked package reachable from the app's `dependencies` and its
 * `linked.unpublishedPackages` (transitively, through each package's own
 * `dependencies` and list), each one AFTER
 * the linked packages it depends on. Providers register middleware in the
 * order they are indexed, so a package's middleware must not run before that
 * of a package it builds on (e.g. anything reading `request.linkedAuth` after
 * @_linked/auth's JWT middleware).
 *
 * Only linked packages are recursed into — the same rule the workspace-only
 * filter used — so the walk reads a few dozen package.json files, not the
 * whole of node_modules. Each package's dependencies are resolved from its
 * REAL location, so a symlinked workspace or localized checkout resolves its
 * own dependencies the way Node will when it loads it — which is how a
 * package installed only nested (`owl/node_modules/@_linked/rdfs`) is found.
 *
 * The walk is keyed by real path, not name, so every installed copy of a
 * package is recorded (`copies`). The copy whose backend is loaded (`path`)
 * is the one the app itself resolves, so it is the same module instance the
 * app's own imports reach; when the app cannot resolve the package at all
 * (it is only installed nested) it is the first copy found.
 *
 * `isLinked` decides which installed packages are linked ones (default
 * {@link isLinkedPackageJson}); a caller reading installs of another
 * generation passes its own.
 */
export function discoverLinkedDependencies(
  appDir: string,
  appPackageJson: any,
  isLinked: (json: any) => boolean = isLinkedPackageJson
): LinkedDependency[] {
  const out: LinkedDependency[] = [];
  const byName = new Map<string, LinkedDependency>();
  const visitedRoots = new Set<string>();
  const appName = appPackageJson?.name;

  const visit = (name: string, fromDir: string, listed = false) => {
    if (name === appName) return;
    const installed = listed
      ? findListedPackage(name, fromDir, appDir)
      : readInstalledPackage(name, fromDir);
    if (!installed || !isLinked(installed.json)) return;
    const realRoot = realpathOr(installed.root);
    if (visitedRoots.has(realRoot)) return;
    visitedRoots.add(realRoot);
    let entry = byName.get(name);
    if (!entry) {
      entry = { packageName: name, path: realRoot, copies: [] };
      byName.set(name, entry);
    }
    entry.copies.push({ path: realRoot, version: installed.json.version });
    for (const dep of Object.keys(installed.json.dependencies ?? {})) {
      visit(dep, realRoot);
    }
    for (const dep of unpublishedNames(installed.json)) {
      visit(dep, realRoot, true);
    }
    // Pushed after its dependencies, once per name: the first copy found
    // fixes the package's place in the order.
    if (!out.includes(entry)) out.push(entry);
  };

  for (const name of Object.keys(appPackageJson?.dependencies ?? {})) {
    visit(name, appDir);
  }
  for (const name of unpublishedNames(appPackageJson)) {
    visit(name, appDir, true);
  }

  for (const entry of out) {
    if (entry.copies.length < 2) continue;
    const fromApp = readInstalledPackage(entry.packageName, appDir);
    if (fromApp && isLinked(fromApp.json)) {
      const appCopy = realpathOr(fromApp.root);
      if (entry.copies.some((c) => c.path === appCopy)) entry.path = appCopy;
    }
  }
  return out;
}

/**
 * Package name → the names of its direct `dependencies`, `peerDependencies` and
 * `linked.unpublishedPackages`, for the app
 * (`appPackageJson`) and every package in `packageDirs` (name → package root, as discovery
 * found it). The shape check scopes its direction-I errors with it. A package whose
 * `package.json` cannot be read is left out.
 */
export function readDependencyLists(
  packageDirs: Iterable<[string, string]>,
  appPackageJson?: any
): Record<string, string[]> {
  const lists: Record<string, string[]> = {};
  const add = (name: unknown, json: any) => {
    if (typeof name !== 'string' || !name) return;
    lists[name] = [
      ...new Set([
        ...Object.keys(json?.dependencies ?? {}),
        ...Object.keys(json?.peerDependencies ?? {}),
        ...unpublishedNames(json),
      ]),
    ].sort();
  };
  if (appPackageJson) add(appPackageJson.name, appPackageJson);
  for (const [name, dir] of packageDirs) {
    try {
      add(name, JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')));
    } catch {}
  }
  return lists;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The conditions a backend entry is resolved with on the Node path. These are
 * the ones Node's ESM loader applies to `import()` — so the file found is the
 * file a bare `import('<pkg>/backend')` from the app would load, and Node's
 * module cache (keyed by real file URL) hands both the same instance.
 * `development` is deliberately absent: it is a Vite/bundler condition, and a
 * production Node runtime never applies it.
 */
export const NODE_IMPORT_CONDITIONS = ['import', 'node', 'default'] as const;

/**
 * The absolute path of a package's backend entry file, or null when the
 * package has no backend entry or the file it names does not exist.
 *
 * With `exports`, this follows Node's PACKAGE_EXPORTS_RESOLVE for the
 * `./backend` subpath: an exact `./backend` key wins; otherwise the `./*`-style
 * pattern with the longest matching prefix; condition objects (nested or not)
 * pick the first key that is one of `conditions` or `default`; arrays take the
 * first target that resolves. A package that has `exports` but nothing
 * matching `./backend` has no backend — exactly as Node would refuse to
 * import it.
 *
 * Without `exports`, the legacy layout: `<root>/backend.js`,
 * `<root>/backend/index.js`, and the layout linked packages build to — a
 * `backend.js` next to `main` (`lib/esm/backend.js`).
 *
 * Hand-written rather than via `resolve.exports`: that package also stops at
 * a path and leaves the existence check to the caller, the subset needed is
 * ~50 lines, and the server keeps one less dependency in every app's install.
 */
export function resolveBackendEntry(
  pkgRoot: string,
  pkgJson: any,
  conditions: readonly string[] = NODE_IMPORT_CONDITIONS
): string | null {
  const exists = (rel: string) => packageFile(pkgRoot, rel);
  const exportsField = pkgJson?.exports;
  if (exportsField === undefined || exportsField === null) {
    const candidates = ['backend.js', 'backend/index.js'];
    if (typeof pkgJson?.main === 'string') {
      candidates.push(path.join(path.dirname(pkgJson.main), 'backend.js'));
    }
    candidates.push('lib/esm/backend.js');
    for (const rel of candidates) {
      const file = exists(rel);
      if (file) return file;
    }
    return null;
  }
  return resolveBackendExport(exportsField, conditions, exists);
}

/** `<pkgRoot>/<rel>` when it is a file inside the package, else null. */
function packageFile(pkgRoot: string, rel: string): string | null {
  const file = path.resolve(pkgRoot, rel);
  // Never let an export target escape the package.
  if (!file.startsWith(path.resolve(pkgRoot) + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * The `./backend` subpath of an `exports` map, resolved per Node's
 * PACKAGE_EXPORTS_RESOLVE (see resolveBackendEntry). `probe` turns a matched
 * `./`-relative target into a file, or null when it does not resolve.
 */
function resolveBackendExport(
  exportsField: any,
  conditions: readonly string[],
  probe: (rel: string) => string | null
): string | null {
  // `"exports": "./x.js"`, an array, or a condition object at the top level
  // are all sugar for the "." subpath only.
  if (
    typeof exportsField !== 'object' ||
    Array.isArray(exportsField) ||
    !Object.keys(exportsField).some((k) => k.startsWith('.'))
  ) {
    return null;
  }

  const subpath = './backend';
  let target: any;
  let patternMatch: string | null = null;
  if (Object.prototype.hasOwnProperty.call(exportsField, subpath)) {
    target = exportsField[subpath];
  } else {
    let bestKey: string | null = null;
    for (const key of Object.keys(exportsField)) {
      const star = key.indexOf('*');
      if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (
        subpath !== prefix &&
        subpath.length >= key.length &&
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        (bestKey === null || patternKeyCompare(bestKey, key) > 0)
      ) {
        bestKey = key;
        patternMatch = subpath.slice(prefix.length, subpath.length - suffix.length);
      }
    }
    if (bestKey === null) return null;
    target = exportsField[bestKey];
  }

  const resolveTarget = (t: any): string | null => {
    if (typeof t === 'string') {
      if (!t.startsWith('./')) return null;
      const rel = patternMatch === null ? t : t.split('*').join(patternMatch);
      return probe(rel);
    }
    if (Array.isArray(t)) {
      for (const item of t) {
        const file = resolveTarget(item);
        if (file) return file;
      }
      return null;
    }
    if (t && typeof t === 'object') {
      for (const key of Object.keys(t)) {
        if (key === 'default' || conditions.includes(key)) {
          // Node takes the first matching condition even if its target fails
          // to resolve; it does not fall through to later keys.
          return resolveTarget(t[key]);
        }
      }
    }
    return null;
  };
  return resolveTarget(target);
}

/**
 * The SOURCE file a dev Vite runner loads for `<pkg>/backend` when the
 * package is a source package — its real root has a `src/` directory, which is
 * what makes `linked`'s Vite config register it as a workspace (cli
 * `discoverWorkspaces` / `readSourcePackage`). Null when the package has no
 * `src/` or no source backend; the caller then falls back to
 * resolveBackendEntry (a built `lib/` copy, or nothing).
 *
 * Mirrors the cli's `resolveWorkspaceSpecifier` for the `./backend` subpath,
 * which runs BEFORE `exports`: `src/backend.tsx`, `src/backend.ts`, then the
 * package's own `exports` under `import`/`default` with a `./lib/esm/X.js`
 * target mapped to `src/X.tsx` / `src/X.ts` (any other `./lib/esm/` target to
 * the same path under src). So an unbuilt workspace, whose `exports` name only
 * `lib/esm`, still has its backend found, and a built one reports the src file
 * Vite actually evaluates rather than its stale `lib/`.
 *
 * Only meaningful when the dev Vite runner owns the package; Node (production,
 * external packages) loads `lib/` and never sees src.
 */
export function resolveSourceBackendEntry(
  pkgRoot: string,
  pkgJson: any
): string | null {
  try {
    if (!fs.statSync(path.join(pkgRoot, 'src')).isDirectory()) return null;
  } catch {
    return null;
  }
  for (const rel of ['src/backend.tsx', 'src/backend.ts']) {
    const file = packageFile(pkgRoot, rel);
    if (file) return file;
  }
  const exportsField = pkgJson?.exports;
  if (exportsField === undefined || exportsField === null) return null;
  const libPrefix = './lib/esm/';
  return resolveBackendExport(exportsField, ['import'], (rel) => {
    if (!rel.startsWith(libPrefix)) return null;
    const sub = rel.slice(libPrefix.length);
    if (/\.jsx?$/.test(sub)) {
      const base = 'src/' + sub.replace(/\.jsx?$/, '');
      return packageFile(pkgRoot, base + '.tsx') ?? packageFile(pkgRoot, base + '.ts');
    }
    return packageFile(pkgRoot, 'src/' + sub);
  });
}

/** Node's PATTERN_KEY_COMPARE: < 0 means `a` is the more specific pattern. */
function patternKeyCompare(a: string, b: string): number {
  const aBase = a.indexOf('*');
  const bBase = b.indexOf('*');
  const baseA = aBase === -1 ? a.length : aBase + 1;
  const baseB = bBase === -1 ? b.length : bBase + 1;
  if (baseA > baseB) return -1;
  if (baseB > baseA) return 1;
  if (aBase === -1) return 1;
  if (bBase === -1) return -1;
  if (a.length > b.length) return -1;
  if (b.length > a.length) return 1;
  return 0;
}

/**
 * Whether the dev SSR runner BUNDLES `pkgName` (it is in Vite's
 * `ssr.noExternal`) rather than handing it to Node.
 *
 * This decides which loader a package's backend must be loaded with. A module
 * has to be evaluated by the same loader that evaluates the package everywhere
 * else in the SSR graph, or it runs twice:
 *
 *  - `vite.ssrLoadModule('<external pkg>/backend')` transforms that entry and
 *    its relative imports even though the package is external, while the app's
 *    bare imports of the same package are evaluated by Node — two copies of the
 *    package's module state.
 *  - a plain `import()` of a BUNDLED package goes to Node, while the app's
 *    imports of it are evaluated by Vite — the same split the other way round.
 *
 * Vite matches `noExternal` entries against the bare package name, so a
 * subpath (`pkg/backend`) is covered by an entry for `pkg`.
 */
export function isBundledBySsr(pkgName: string, noExternal: unknown): boolean {
  if (noExternal === true) return true;
  const entries = Array.isArray(noExternal)
    ? noExternal
    : noExternal
      ? [noExternal]
      : [];
  return entries.some((entry) =>
    typeof entry === 'string'
      ? entry === pkgName
      : entry instanceof RegExp
        ? entry.test(pkgName)
        : false
  );
}

/** The dev SSR runner's resolved `noExternal`, wherever this Vite keeps it. */
export function ssrNoExternalOf(vite: any): unknown {
  return (
    vite?.config?.ssr?.noExternal ??
    vite?.config?.environments?.ssr?.resolve?.noExternal
  );
}

/**
 * The backend entry of a package the dev Vite runner owns (see isBundledBySsr):
 * its source backend when it is a source package (resolveSourceBackendEntry),
 * otherwise what `exports` names under the `development` condition and Node's
 * import conditions. A registry install has no src/, so it resolves exactly
 * as before.
 */
export function resolveDevBackendEntry(
  pkgRoot: string,
  pkgJson: any
): string | null {
  return (
    resolveSourceBackendEntry(pkgRoot, pkgJson) ??
    resolveBackendEntry(pkgRoot, pkgJson, [
      'development',
      ...NODE_IMPORT_CONDITIONS,
    ])
  );
}
