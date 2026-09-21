/**
 * Read the release manifest `@_linked/cli` writes next to the client bundle,
 * and work out which base URL the server should render its asset tags with.
 *
 * `linked build-app` (CLI >= 1.19) publishes every release under a versioned
 * key prefix (`releases/<version>-<revision>/…`) and records where it was built
 * for in `public/bundles/linked-release.json`. Before that manifest existed the
 * only way to point a running server at a published release was to set
 * `STATIC_ACCESS_URL` to `<accessURL>/<releasePrefix>` by hand — a value that
 * has to be edited on every release and that silently serves the wrong (or a
 * deleted) release when it drifts from what was actually published.
 *
 * Reading the manifest removes that step. Nothing here changes what a server
 * without a manifest does: every existing app keeps the exact behaviour it has.
 */
import * as fsNative from 'fs';
import path from 'path';

/** Path of the manifest, relative to the app root. Set by `@_linked/cli`. */
export const RELEASE_MANIFEST_PATH = 'public/bundles/linked-release.json';

/**
 * Manifest schema versions this server understands. An unknown version is
 * ignored rather than guessed at: a later schema may well move or redefine
 * `destination`, and serving assets from a misread URL breaks the whole app,
 * whereas ignoring it only costs the automatic base (the old manual
 * `STATIC_ACCESS_URL` still works).
 */
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS = [1];

/** Directory `vite build` writes the client bundle to, as a URL suffix. */
const BUNDLE_URL_SUFFIX = '/public/bundles';

/** Only the fields this server reads; the CLI owns the full type. */
export interface ReleaseManifestDestination {
  accessURL?: string;
  releasePrefix?: string;
  baseURL?: string;
}

export interface ReleaseManifest {
  schemaVersion?: number;
  appName?: string;
  appVersion?: string;
  releaseId?: string;
  target?: string;
  publishable?: boolean;
  destination?: ReleaseManifestDestination;
}

const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/, '');

/** A base URL is only usable if it is absolute — assets live on another host. */
const isAbsoluteURL = (value: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

/**
 * Read and validate the release manifest of the app rooted at `appRoot`.
 *
 * Returns `null` — never throws — when there is no manifest, when it cannot be
 * parsed, or when it is not a release this server can read. A broken manifest
 * must not stop a server from booting: falling back to the previous behaviour
 * is always safe, crashing never is.
 */
export const readReleaseManifest = (
  appRoot: string = process.cwd(),
  warn: (message: string) => void = console.warn,
): ReleaseManifest | null => {
  const manifestPath = path.resolve(appRoot, RELEASE_MANIFEST_PATH);
  if (!fsNative.existsSync(manifestPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fsNative.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    warn(
      `[LinkedServer] ignoring unreadable release manifest at ${manifestPath}: ${
        (err as Error).message
      }`,
    );
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(
      `[LinkedServer] ignoring release manifest at ${manifestPath}: expected a JSON object`,
    );
    return null;
  }

  const manifest = parsed as ReleaseManifest;
  if (!SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(manifest.schemaVersion as number)) {
    warn(
      `[LinkedServer] ignoring release manifest at ${manifestPath}: unsupported schemaVersion ` +
        `${JSON.stringify(manifest.schemaVersion)} (this server reads ` +
        `${SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(', ')}). Set STATIC_ACCESS_URL to pick a release.`,
    );
    return null;
  }

  return manifest;
};

/**
 * The static access URL a manifest implies: the release's root on the store,
 * i.e. everything the server prefixes `/public/<asset>` with. `''` when the
 * manifest describes no published location.
 *
 * `destination.baseURL` is preferred because it is the literal value the client
 * bundle was built with as Vite's `base`, so deriving the server's tags from it
 * guarantees the entry tags and the bundle's own chunk URLs agree. It points at
 * the bundle directory, so the `/public/bundles` tail comes off again here.
 * `accessURL` + `releasePrefix` is the fallback for a manifest whose `baseURL`
 * is missing, empty (a Capacitor build writes `""`) or shaped unexpectedly.
 */
export const releaseStaticAccessURL = (
  manifest: ReleaseManifest | null,
): string => {
  const destination = manifest?.destination;
  if (!destination || typeof destination !== 'object') return '';

  const baseURL = trimTrailingSlashes(String(destination.baseURL || '').trim());
  if (baseURL && isAbsoluteURL(baseURL) && baseURL.endsWith(BUNDLE_URL_SUFFIX)) {
    return baseURL.slice(0, -BUNDLE_URL_SUFFIX.length);
  }

  const accessURL = trimTrailingSlashes(
    String(destination.accessURL || '').trim(),
  );
  const releasePrefix = String(destination.releasePrefix || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (accessURL && isAbsoluteURL(accessURL) && releasePrefix) {
    return `${accessURL}/${releasePrefix}`;
  }

  // A Capacitor build ships its assets inside the native app: it records an
  // empty destination on purpose and must not influence the server's URLs.
  return '';
};

export interface ResolveStaticAccessURLOptions {
  /** `true` in development, where Vite serves assets from the app's origin. */
  isDevAssets?: boolean;
  env?: NodeJS.ProcessEnv;
  /** The app root to look for the release manifest in. */
  appRoot?: string;
  /** Pre-read manifest; read from `appRoot` when omitted. */
  manifest?: ReleaseManifest | null;
  /** `LinkedFileStorage.accessURL` — today's last resort. */
  fileStoreAccessURL?: string;
  warn?: (message: string) => void;
}

/**
 * Resolve the base URL the server renders asset tags with, in this order:
 *
 * 1. development — always a relative path, so bundle URLs work on whatever port
 *    the dev server bound to and Vite keeps serving the assets itself;
 * 2. `STATIC_ACCESS_URL` — an explicit deployment decision, and every existing
 *    deployment that pins a release already sets it, so it has to keep winning;
 * 3. the release manifest's destination — the release this build was actually
 *    published as;
 * 4. `LinkedFileStorage.accessURL`, then `''` — exactly what happened before.
 *
 * The returned value never has a trailing slash, so callers can append
 * `/public/<path>` to it.
 */
export const resolveStaticAccessURL = ({
  isDevAssets = false,
  env = process.env,
  appRoot = process.cwd(),
  manifest,
  fileStoreAccessURL,
  warn = console.warn,
}: ResolveStaticAccessURLOptions = {}): string => {
  if (isDevAssets) return '';

  const explicit = String(env.STATIC_ACCESS_URL || '').trim();
  if (explicit) return trimTrailingSlashes(explicit);

  const resolvedManifest =
    manifest === undefined ? readReleaseManifest(appRoot, warn) : manifest;
  const fromRelease = releaseStaticAccessURL(resolvedManifest);
  if (fromRelease) return fromRelease;

  return trimTrailingSlashes(String(fileStoreAccessURL || '').trim());
};

/**
 * Build the URL of one asset under `public/`, the way the HTML entry tags do.
 * `assetPath` is app-relative and starts with a slash, e.g. `/bundles/main.js`.
 */
export const staticAssetURL = (
  staticAccessURL: string,
  assetPath: string,
): string => `${trimTrailingSlashes(staticAccessURL)}/public${assetPath}`;
