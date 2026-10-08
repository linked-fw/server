/**
 * Node's own `import()`, out of reach of any bundler or SSR transform.
 *
 * Under an app's dev SSR runner this package is itself evaluated by Vite, and
 * Vite's SSR transform rewrites every `import()` it can see into its own
 * module loader — `@vite-ignore` only silences the warning, it does not stop
 * the rewrite. An installed package's backend loaded that way becomes a second,
 * Vite-evaluated instance alongside the one Node already loaded for the app's
 * own imports, and both register their shapes (whichever registers last wins).
 *
 * Building the call with the Function constructor keeps it out of the source
 * any transform parses, so it always resolves through Node's ESM loader and
 * its cache: one instance per resolved file.
 */
export const nativeImport = new Function(
  'specifier',
  'return import(specifier);'
) as (specifier: string) => Promise<any>;
