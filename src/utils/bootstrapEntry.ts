/**
 * Decide how the client entry is handed to `renderToPipeableStream`.
 *
 * React renders `bootstrapScripts` as a plain `<script src async>`. Vite always
 * emits the client entry as an ES module, so a production Vite build served
 * that way died on its first line with "Cannot use import statement outside a
 * module" and the app never hydrated. An entry that came out of a Vite
 * manifest therefore goes through `bootstrapModules` — the same tag with
 * `type="module"` — while a legacy webpack bundle is a classic script and has
 * to keep `bootstrapScripts`.
 */
import type { BundleManifest, ViteManifestEntry } from './routeAssets.js';

/**
 * The Vite manifest's client entry, or null when the manifest has none.
 *
 * Vite keys the entry by its source path; `isEntry` is the fallback for an app
 * whose entry does not sit at `src/index.*`.
 */
export const resolveViteMainEntry = (
  manifest: BundleManifest,
): ViteManifestEntry | null => {
  const entry =
    manifest['src/index.tsx'] ||
    manifest['src/index.ts'] ||
    Object.values(manifest).find((e: any) => e?.isEntry);
  return entry && typeof entry === 'object' ? (entry as ViteManifestEntry) : null;
};

/**
 * Is a live Vite dev server serving this request?
 *
 * Two decisions hang off this answer — how the client entry is bootstrapped
 * (dev preamble vs. the built entry) and whether route preload tags are
 * emitted — and they have to agree. Asking `config.server.vite` alone is not
 * enough: a *production* Vite build can be run from a config that still
 * carries `server.vite`, and answering "dev" there hands the browser an
 * inline preamble importing `/@vite/client`, which does not exist in
 * production, so nothing hydrates.
 *
 * The build manifest is what actually separates the two. Once a manifest has
 * been loaded the built assets are on disk and must be used, `server.vite`
 * notwithstanding. Keep both call sites on this one function so they cannot
 * drift apart again.
 */
export const isViteDevServer = ({
  viteConfig,
  buildOutput,
}: {
  /** `config.server.vite` — present whenever the app is a Vite app at all. */
  viteConfig: unknown;
  /**
   * Evidence that `vite build` has run: the latest build manifest, or the
   * entry resolved out of it. Falsy means there is nothing built to serve,
   * which is the one thing only dev mode is true of.
   */
  buildOutput: unknown;
}): boolean => !!viteConfig && !buildOutput;

/** The subset of `renderToPipeableStream` options that boots the client. */
export interface BootstrapEntryOptions {
  bootstrapScriptContent?: string;
  bootstrapModules?: string[];
  bootstrapScripts?: string[];
}

/**
 * Vite dev-mode preamble. Vite middleware intercepts `/src/index.tsx` and
 * transforms+serves it; `/@vite/client` provides the HMR client.
 * `@vitejs/plugin-react` requires this preamble to define
 * `$RefreshReg$`/`$RefreshSig$` — without it the first React module throws
 * "can't detect preamble" and hydration blows up.
 */
export const VITE_DEV_BOOTSTRAP_CONTENT = `
                import("/@vite/client");
                import("/@react-refresh").then(RefreshRuntime => {
                  RefreshRuntime.injectIntoGlobalHook(window);
                  window.$RefreshReg$ = () => {};
                  window.$RefreshSig$ = () => (type) => type;
                  window.__vite_plugin_react_preamble_installed__ = true;
                  return import("/src/index.tsx");
                });
              `;

export const resolveBootstrapEntry = ({
  viteDevServer,
  mainEntryIsModule,
  mainEntry,
}: {
  /** The Vite dev server is running, so it serves and transforms the entry. */
  viteDevServer: boolean;
  /** `mainEntry` was resolved from a Vite manifest, so it is an ES module. */
  mainEntryIsModule: boolean;
  /** URL of the built client entry. */
  mainEntry: string;
}): BootstrapEntryOptions => {
  if (viteDevServer) {
    return { bootstrapScriptContent: VITE_DEV_BOOTSTRAP_CONTENT };
  }
  return mainEntryIsModule
    ? { bootstrapModules: [mainEntry] }
    : { bootstrapScripts: [mainEntry] };
};
