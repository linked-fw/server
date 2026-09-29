/**
 * Which Vite module-graph ids the dev SSR inlines as CSS.
 *
 * In Vite dev, CSS reaches the browser through JS after hydration, so the
 * server inlines what the graph already holds into `<style id="ssr-css">` to
 * avoid an unstyled first paint. Each stylesheet is loaded as `<file>?inline`,
 * which makes Vite return the processed CSS as a string default export.
 *
 * Not every `.css` id in the graph can be loaded that way:
 *
 *  - `?direct` ids are added by Vite's transform middleware when a browser
 *    requests a stylesheet with `Accept: text/css` (a `<link>`). Loading one
 *    returns raw CSS, which the SSR transform then parses as JavaScript —
 *    "Parse failure: Expected ';', '}' or <eof>".
 *  - Files under Vite's `publicDir` are served verbatim and are not part of
 *    the app's styles; a stale production bundle under `public/bundles/` is
 *    the usual one.
 *  - `?inline` (our own loads), `?raw` and `?url` ids are not stylesheets.
 *
 * The same file also appears under several ids (with and without a query,
 * or once per graph), so ids are reduced to their file and each file is
 * loaded once, in first-seen order to keep the cascade order.
 */
const NON_STYLESHEET_QUERY = ['inline', 'direct', 'raw', 'url'];

export const ssrCssInlineUrls = (
  ids: Iterable<string>,
  { publicDir }: { publicDir?: string | false } = {},
): string[] => {
  const publicPrefix = publicDir ? publicDir.replace(/\/+$/, '') + '/' : null;
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const id of ids) {
    const queryAt = id.indexOf('?');
    const file = queryAt === -1 ? id : id.slice(0, queryAt);
    if (!file.endsWith('.css')) continue;
    if (queryAt !== -1) {
      const params = new URLSearchParams(id.slice(queryAt + 1));
      if (NON_STYLESHEET_QUERY.some((key) => params.has(key))) continue;
    }
    if (publicPrefix && file.startsWith(publicPrefix)) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    urls.push(file + '?inline');
  }
  return urls;
};

/**
 * One module of Vite's SSR module graph, as far as scoping reads it — a
 * structural subset of Vite's `EnvironmentModuleNode`.
 */
export interface SsrCssModule {
  id: string | null;
  url: string;
  importedModules: Iterable<SsrCssModule>;
  transformResult?: { deps?: string[]; dynamicDeps?: string[] } | null;
  /** The module's evaluated exports, once the SSR runner has loaded it. */
  ssrModule?: Record<string, unknown> | null;
}

const isStylesheetId = (id: string) => {
  const queryAt = id.indexOf('?');
  return (queryAt === -1 ? id : id.slice(0, queryAt)).endsWith('.css');
};

const findModuleExporting = (
  modules: SsrCssModule[],
  value: unknown,
): SsrCssModule | undefined =>
  modules.find((m) => {
    const exports = m.ssrModule;
    if (!m.id || !exports || typeof exports !== 'object') return false;
    for (const key of Object.keys(exports)) {
      try {
        if (exports[key] === value) return true;
      } catch {
        // an export still in its temporal dead zone (a circular import)
      }
    }
    return false;
  });

/**
 * The module ids whose stylesheets one page render needs: everything the app
 * module and the matched pages import statically — what a production build
 * puts in the entry CSS plus the route's chunk CSS.
 *
 * Walking the whole graph instead inlines every page's CSS into every page,
 * because the dev server preloads all pages into the graph (megabytes in a
 * large app). Two kinds of edge are therefore not followed:
 *
 *  - dynamic imports: `routes` imports every page lazily; the matched pages
 *    are passed in as entries instead. A lazily loaded component's CSS arrives
 *    with it, as in production.
 *  - edges from a stylesheet to anything but another stylesheet: Tailwind's
 *    Vite plugin registers every source file it scans as a dependency of the
 *    stylesheet that runs it, so following them reaches every page again.
 *
 * `app` and `pages` are components; their modules are found by export
 * identity. Returns null when one of them cannot be found — the caller should
 * then fall back to the whole graph rather than drop a page's styles.
 */
export const ssrCssScope = (
  modules: Iterable<SsrCssModule>,
  { app, pages }: { app: unknown; pages: unknown[] },
): Set<string> | null => {
  const all = [...modules];
  const entries: SsrCssModule[] = [];
  for (const component of [app, ...pages]) {
    const module = findModuleExporting(all, component);
    if (!module) return null;
    entries.push(module);
  }

  const scope = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const module = stack.pop()!;
    if (!module.id || scope.has(module.id)) continue;
    scope.add(module.id);
    const fromStylesheet = isStylesheetId(module.id);
    const staticDeps = new Set(module.transformResult?.deps ?? []);
    const dynamicDeps = new Set(module.transformResult?.dynamicDeps ?? []);
    for (const child of module.importedModules) {
      if (!child.id || scope.has(child.id)) continue;
      if (fromStylesheet && !isStylesheetId(child.id)) continue;
      if (dynamicDeps.has(child.url) && !staticDeps.has(child.url)) continue;
      stack.push(child);
    }
  }
  return scope;
};

const REACT_LAZY = Symbol.for('react.lazy');

/**
 * The component a route renders, loading it first if it is `React.lazy`.
 * Returns null for a route without one, and undefined when it cannot be
 * known (a `render` function, or a lazy component that fails to load).
 *
 * Reads React.lazy's `_init`/`_payload` — the same pair React itself calls,
 * stable since lazy was introduced — because a lazy component exposes nothing
 * else that says which module it loads.
 */
export const resolveRouteComponent = async (route: {
  component?: unknown;
  render?: unknown;
}): Promise<unknown> => {
  const component = route.component as any;
  if (!component) return route.render ? undefined : null;
  if (component.$$typeof !== REACT_LAZY) return component;
  if (typeof component._init !== 'function') return undefined;
  const init = () => component._init(component._payload);
  try {
    return init();
  } catch (thrown) {
    if (!thrown || typeof (thrown as any).then !== 'function') return undefined;
    try {
      await thrown;
      return init();
    } catch {
      return undefined;
    }
  }
};
