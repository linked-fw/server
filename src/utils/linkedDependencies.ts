import * as fs from 'fs';
import * as path from 'path';

/**
 * A linked package found in the app's dependency tree, wherever it is
 * installed: a workspace member, a localized checkout, or a registry install.
 */
export interface LinkedDependency {
  packageName: string;
  /** Realpath of the package root. */
  path: string;
}

/**
 * A package whose backend providers the server loads at boot: one whose
 * package.json declares `"linkedPackage": true`. That flag is the only test —
 * not the package's scope. `@_linked/localize` is in the `@_linked` scope and
 * is a CLI tool, not a linked package; a custom-scope package with the flag is
 * a linked package. The CLI's workspace discovery uses the same flag.
 *
 * The legacy `"lincd": true` flag is deliberately NOT enough. Those packages
 * import the old `lincd` core, and loading them at boot is what produced
 * "Multiple versions of LINCD are loaded" before boot loading was narrowed to
 * workspace members.
 */
export function isLinkedPackageJson(json: any): boolean {
  if (!json || typeof json.name !== 'string') return false;
  return json.linkedPackage === true;
}

/**
 * Find an installed package the way Node does: `<dir>/node_modules/<name>`,
 * then each parent directory's `node_modules`. Returns null when it is not
 * installed (an optional dependency, say) rather than throwing.
 */
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
 * Every linked package reachable from the app's `dependencies`, each one AFTER
 * the linked packages it depends on. Providers register middleware in the
 * order they are indexed, so a package's middleware must not run before that
 * of a package it builds on (e.g. anything reading `request.linkedAuth` after
 * @_linked/auth's JWT middleware).
 *
 * Only linked packages are recursed into — the same rule the workspace-only
 * filter used — so the walk reads a few dozen package.json files, not the
 * whole of node_modules. Each package's dependencies are resolved from its
 * REAL location, so a symlinked workspace or localized checkout resolves its
 * own dependencies the way Node will when it loads it.
 */
export function discoverLinkedDependencies(
  appDir: string,
  appPackageJson: any
): LinkedDependency[] {
  const out: LinkedDependency[] = [];
  const seen = new Set<string>();
  if (appPackageJson?.name) seen.add(appPackageJson.name);

  const visit = (name: string, fromDir: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const installed = readInstalledPackage(name, fromDir);
    if (!installed || !isLinkedPackageJson(installed.json)) return;
    let realRoot = installed.root;
    try {
      realRoot = fs.realpathSync(installed.root);
    } catch {}
    for (const dep of Object.keys(installed.json.dependencies ?? {})) {
      visit(dep, realRoot);
    }
    out.push({ packageName: name, path: realRoot });
  };

  for (const name of Object.keys(appPackageJson?.dependencies ?? {})) {
    visit(name, appDir);
  }
  return out;
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
