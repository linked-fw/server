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
