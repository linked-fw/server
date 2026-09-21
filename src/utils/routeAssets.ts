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

/**
 * Last-resort match for a chunk name whose casing does not line up with the
 * manifest.
 *
 * Webpack named its chunks after the route (`home`, `signin`); Vite keys its
 * manifest by source path (`src/pages/Home.tsx`). An app carrying the old
 * lowercase `preloadChunks` therefore matched nothing at all. This compares the
 * file's basename case-insensitively, anchored on the path separator so
 * `Home` cannot be answered by `MyHome.tsx`.
 */
const caseInsensitiveEntryFor = (
  manifest: BundleManifest,
  chunkName: string,
): ViteManifestEntry | null => {
  const lower = chunkName.toLowerCase();
  const entry = Object.values(manifest).find((e: any) => {
    const src = typeof e?.src === 'string' ? e.src.toLowerCase() : null;
    if (!src) return false;
    return ['tsx', 'ts'].some((ext) => {
      const name = `${lower}.${ext}`;
      return src === name || src.endsWith(`/${name}`);
    });
  });
  return entry && typeof entry === 'object' ? (entry as ViteManifestEntry) : null;
};

/**
 * Find the Vite manifest entry for a route chunk, by source path, by tail, or
 * — only once both of those miss — by a case-insensitive basename.
 */
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
  if (entry && typeof entry === 'object') return entry as ViteManifestEntry;
  return caseInsensitiveEntryFor(manifest, chunkName);
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

/**
 * Chunk names already reported as unresolved.
 *
 * A route's `preloadChunks` are resolved on every render of that route, so a
 * name the manifest does not know would otherwise warn on every request. One
 * line per name is enough: the fix is in the app's source, not in this run.
 */
const warnedUnresolvedChunks = new Set<string>();

/** Forget which chunk names have been warned about. For tests. */
export const resetUnresolvedChunkWarnings = (): void => {
  warnedUnresolvedChunks.clear();
};

/**
 * Say so when a declared preload chunk resolves to nothing.
 *
 * Silence here is what let an app ship webpack-era lowercase `preloadChunks`
 * against a Vite manifest and emit no preload tags at all, with nothing
 * visibly broken.
 */
const warnUnresolvedChunk = (chunkName: string): void => {
  if (warnedUnresolvedChunks.has(chunkName)) return;
  warnedUnresolvedChunks.add(chunkName);
  console.warn(
    `[routeAssets] preloadChunk "${chunkName}" matched nothing in the bundle manifest — ` +
      'no preload tags will be emitted for it. Check that the name matches the ' +
      'page source file (Vite manifest keys look like "src/pages/Home.tsx").',
  );
};

/** The preload URLs for every chunk a matched route asked for. */
export const resolveRouteAssets = (
  manifest: BundleManifest,
  chunkNames: string[],
  staticAccessURL: string,
): { scripts: string[]; styles: string[] } => {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const chunkName of chunkNames) {
    const script = resolveRouteScript(manifest, chunkName, staticAccessURL);
    const chunkStyles = resolveRouteStyles(manifest, chunkName, staticAccessURL);
    if (script) scripts.push(script);
    styles.push(...chunkStyles);
    if (!script && chunkStyles.length === 0) warnUnresolvedChunk(chunkName);
  }
  return { scripts, styles };
};
