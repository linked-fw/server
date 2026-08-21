/**
 * True only for source CSS that Vite may safely load with `?inline` during SSR.
 *
 * Vite adds public-dir assets to the module graph with `?direct`. They are
 * already-built output, not source CSS. Appending `inline` produces
 * `?direct&inline`, which Vite tries to parse as JavaScript and reports as a
 * raw-CSS parse failure on every SSR request.
 */
export function isViteSsrSourceCss(id: string): boolean {
  if (typeof id !== 'string') return false;
  const queryIndex = id.indexOf('?');
  const pathname = (queryIndex === -1 ? id : id.slice(0, queryIndex)).replace(
    /\\/g,
    '/',
  );
  const query = queryIndex === -1 ? '' : id.slice(queryIndex + 1);
  const queryParams = new URLSearchParams(query);
  if (
    queryParams.has('direct') ||
    queryParams.has('inline') ||
    pathname.includes('/public/bundles/') ||
    pathname.startsWith('/bundles/')
  ) {
    return false;
  }
  return /\.(module\.)?css$/.test(pathname);
}
