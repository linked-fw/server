/**
 * How the server loads a module of a package by its specifier at runtime (core's
 * `shapesToTurtle` for the dev shape generator, a linked package's index).
 *
 * In dev, `linked start` runs the app in Vite's SSR runner and installs a module loader for
 * core (`Symbol.for('@_linked/core:importModule')`). That loader gives each specifier the copy
 * the app's own import of it gets: the runner's for a package Vite bundles, Node's for one it
 * leaves external. `vite.ssrLoadModule` does not: it transforms the entry it is handed even when
 * its package is external, so an installed `@_linked/core` loaded that way is a second copy next
 * to Node's, with its own shape registry and `Shape` base class.
 *
 * So the server loads package modules through core's `importPackageModule`, which goes through
 * that loader when one is installed and is Node's `import()` otherwise. Only a host that runs the
 * server with a Vite dev server but installs no loader keeps `ssrLoadModule`, as before.
 */
import {importPackageModule, installedModuleLoader} from '@_linked/core/utils/importPackageModule';

/** The part of a Vite dev server this module uses. */
export type SsrModuleLoader = {ssrLoadModule?: (url: string) => Promise<unknown>} | undefined | null;

/**
 * Load the module at a package specifier the way the app's own import of it is loaded: through
 * the host's module loader when one is installed (`linked start`), else through `vite` when the
 * server runs with one, else Node's `import()`.
 */
export function loadPackageModule(specifier: string, vite?: SsrModuleLoader): Promise<unknown> {
  if (installedModuleLoader()) return importPackageModule(specifier);
  const ssrLoadModule = vite?.ssrLoadModule;
  if (typeof ssrLoadModule === 'function') return ssrLoadModule.call(vite, specifier);
  return importPackageModule(specifier);
}
