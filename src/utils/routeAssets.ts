/**
 * Resolve the JS/CSS a matched route wants preloaded into URLs, on the same
 * base the entry tags (`main.js` / `main.css`) already use.
 *
 * Route chunks used to be emitted origin-relative (`/bundles/<file>`) while the
 * entry tags went through `staticAssetURL`. A release served from a file store
 * or CDN then produced a page that asked one host for its entry bundle and the
 * app server for its route chunks — the latter 404ing, since the server mounts
 * the bundle directory at `/public`. Both now compose through
 * `bundleAssetURL`, so every URL on the page points at the build that actually
 * produced the file.
 */
import { bundleAssetURL } from './releaseManifest.js';

/** The fields this server reads from a Vite manifest entry. */
export interface ViteManifestEntry {
  file?: string;
  src?: string;
  css?: string[];
  isEntry?: boolean;
}

/**
 * A bundle manifest. Vite keys entries by source path and maps them to objects;
 * the legacy webpack manifest mapped output names to bare URL strings.
 */
export type BundleManifest = Record<string, string | ViteManifestEntry | unknown>;

const isAbsoluteURL = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

/** Find the Vite manifest entry for a route chunk, by source path or by tail. */
const viteEntryFor = (
  manifest: BundleManifest,
  chunkName: string,
): ViteManifestEntry | null => {
  const direct =
    manifest[`src/pages/${chunkName}.tsx`] || manifest[`src/pages/${chunkName}.ts`];
  const entry =
    direct ||
    Object.values(manifest).find(
      (e: any) =>
        e?.src?.endsWith(`${chunkName}.tsx`) || e?.src?.endsWith(`${chunkName}.ts`),
    );
  return entry && typeof entry === 'object' ? (entry as ViteManifestEntry) : null;
};

/**
 * Put a value taken from a webpack-shaped manifest on the asset base.
 *
 * Those values are already URL-ish (`/bundles/page.bundle.js`), so the bundle
 * directory prefix comes off again before `bundleAssetURL` puts the real one
 * back on. An entry that is already absolute names its own host and is left
 * alone.
 */
const webpackAssetURL = (value: string, staticAccessURL: string): string => {
  if (isAbsoluteURL(value)) return value;
  const bundleRelative = value.replace(/^\/+/, '').replace(/^bundles\//, '');
  return bundleAssetURL(staticAccessURL, bundleRelative);
};

/** Resolve a route chunk's script URL, or null when the manifest has none. */
export const resolveRouteScript = (
  manifest: BundleManifest,
  chunkName: string,
  staticAccessURL: string,
): string | null => {
  const viteEntry = viteEntryFor(manifest, chunkName);
  if (viteEntry?.file) {
    return bundleAssetURL(staticAccessURL, viteEntry.file);
  }
  // Webpack shape: keyed by output name.
  const webpackEntry =
    manifest[`${chunkName}.js`] ||
    manifest[`${chunkName}.bundle.js`] ||
    manifest[`${chunkName}.mjs`];
  return typeof webpackEntry === 'string'
    ? webpackAssetURL(webpackEntry, staticAccessURL)
    : null;
};

/** Resolve a route chunk's stylesheet URLs. */
export const resolveRouteStyles = (
  manifest: BundleManifest,
  chunkName: string,
  staticAccessURL: string,
): string[] => {
  const viteEntry = viteEntryFor(manifest, chunkName);
  if (viteEntry && Array.isArray(viteEntry.css)) {
    return viteEntry.css.map((css) => bundleAssetURL(staticAccessURL, css));
  }
  const webpackCss = manifest[`${chunkName}.css`];
  return typeof webpackCss === 'string'
    ? [webpackAssetURL(webpackCss, staticAccessURL)]
    : [];
};

/** The preload URLs for every chunk a matched route asked for. */
export const resolveRouteAssets = (
  manifest: BundleManifest,
  chunkNames: string[],
  staticAccessURL: string,
): { scripts: string[]; styles: string[] } => ({
  scripts: chunkNames
    .map((chunkName) => resolveRouteScript(manifest, chunkName, staticAccessURL))
    .filter((url): url is string => !!url),
  styles: chunkNames.flatMap((chunkName) =>
    resolveRouteStyles(manifest, chunkName, staticAccessURL),
  ),
});
