import { publicUploadPath } from '@_linked/server-utils/utils/ServerPaths';

/**
 * Deciding whether `/resized/*` is allowed to fetch a given `src`.
 *
 * The route used to hand `req.query.src` straight to `fetch`, which made every
 * deployment an open proxy into its own network: cloud metadata endpoints,
 * anything on localhost, anything on a private range. The fetched bytes were
 * then written into the *public* file store and the caller redirected to them,
 * so a reachable internal resource was not merely leaked but persisted.
 *
 * The rule now is the one the route always intended, and which the TODO in
 * `resizeImage` described: a `src` may only name an image this app already
 * stores. Everything else is refused before any request is made.
 */

/** Why a `src` was refused. Kept separate from the message so callers can map it to a status. */
export type ResizeSourceRejection =
  | 'unparsable'
  | 'wrong-origin'
  | 'outside-store'
  | 'not-stored';

export interface ResizeSourceAllowed {
  allowed: true;
  /**
   * The key candidates to try against the store, in order.
   *
   * There is more than one because `IFileStore` has no URL-to-key inverse and
   * the two implementations do not agree on the shape. `S3FileStore` serves a
   * key directly under its `accessURL`, so the path *is* the key.
   * `LocalFileStore` serves `accessURL + '/uploads' + '/' + key`, so the same
   * derivation yields `uploads/photo.jpg` for a file stored as `photo.jpg`.
   *
   * Trying both costs one extra `fileExists` in the local case and keeps the
   * check fail-closed: a path that matches neither shape is refused.
   */
  keys: string[];
  /**
   * The URL to fetch: rebuilt from the validated origin and pathname, never the
   * caller's string. A validated string can still carry credentials, a query, a
   * fragment, or percent-encoding that resolves elsewhere, so reusing it would
   * hand back the control the check just took away.
   *
   * Built from the pathname rather than from a key, so it does not depend on
   * which key shape the store uses.
   */
  url: string;
}

export interface ResizeSourceRefused {
  allowed: false;
  reason: ResizeSourceRejection;
}

export type ResizeSourceDecision = ResizeSourceAllowed | ResizeSourceRefused;

/**
 * The first candidate key the store actually holds, or null.
 *
 * Kept here rather than in the route so the two-shape detail stays in one
 * place with the comment that explains it.
 */
export async function findStoredKey(
  keys: string[],
  fileExists: (key: string) => Promise<boolean>
): Promise<string | null> {
  for (const key of keys) {
    if (await fileExists(key)) {
      return key;
    }
  }
  return null;
}

/**
 * Work out the key a `src` refers to inside the store, or why it does not.
 *
 * Origin is compared on parsed URLs, never with `startsWith`: with a string
 * prefix, `https://cdn.example.com.evil.com/x.png` passes a check for
 * `https://cdn.example.com`. `URL.origin` folds in scheme, host and port, and
 * normalises the host, so it cannot be walked past that way.
 *
 * `accessURL` may carry a path (a bucket sub-path, or a CDN mounted under a
 * prefix). The key is what remains of the source's pathname after that prefix,
 * so a source outside the prefix is refused rather than silently resolving to a
 * key that climbs out of it.
 */
export function resolveResizeSource(
  src: string,
  accessURL: string | undefined
): ResizeSourceDecision {
  if (!accessURL) {
    // No store configured means nothing can be proven to belong to it.
    return { allowed: false, reason: 'outside-store' };
  }

  let source: URL;
  let base: URL;
  try {
    source = new URL(src);
    base = new URL(accessURL);
  } catch {
    return { allowed: false, reason: 'unparsable' };
  }

  // Scheme is part of origin, so http:// is refused when the store is https://.
  // That is deliberate: a downgrade is a redirect target waiting to happen.
  if (source.origin !== base.origin || source.origin === 'null') {
    return { allowed: false, reason: 'wrong-origin' };
  }

  // Credentials never belong in a store URL, and `URL.origin` ignores them.
  if (source.username || source.password) {
    return { allowed: false, reason: 'wrong-origin' };
  }

  const basePath = trimTrailingSlash(base.pathname);
  const sourcePath = source.pathname;

  if (basePath && basePath !== '/') {
    if (
      sourcePath !== basePath &&
      !sourcePath.startsWith(basePath + '/')
    ) {
      return { allowed: false, reason: 'outside-store' };
    }
  }

  const relativePath = decodeURIComponent(
    sourcePath.slice(basePath === '/' ? 0 : basePath.length)
  ).replace(/^\/+/, '');

  if (!relativePath || relativePath.includes('\0')) {
    return { allowed: false, reason: 'outside-store' };
  }

  // `..` cannot escape the store through a URL pathname, because the URL parser
  // resolves it before we see it — but a key is also used to build a filesystem
  // path downstream, so refuse it rather than rely on that.
  if (relativePath.split('/').some((segment) => segment === '..')) {
    return { allowed: false, reason: 'outside-store' };
  }

  const keys = [relativePath];
  // LocalFileStore's public URL carries the upload mount that its keys do not.
  const localPrefix = publicUploadPath.replace(/^\/+/, '') + '/';
  if (relativePath.startsWith(localPrefix)) {
    keys.push(relativePath.slice(localPrefix.length));
  }

  return {
    allowed: true,
    keys,
    url: `${trimTrailingSlash(base.origin + basePath)}/${relativePath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** Fetch limits, so an allowed source still cannot exhaust the process. */
export const RESIZE_FETCH_TIMEOUT_MS = 10_000;
export const RESIZE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Fetch a validated store URL under a timeout and a size cap.
 *
 * `redirect: 'error'` matters as much as the origin check: `fetch` follows
 * redirects by default, so without it a store that 302s anywhere would undo the
 * validation one hop later.
 *
 * The cap is enforced while streaming rather than after `arrayBuffer()`, so a
 * response that lies about `content-length`, or omits it, still cannot buffer
 * more than the limit.
 */
export async function fetchStoredImage(
  url: string,
  {
    timeoutMs = RESIZE_FETCH_TIMEOUT_MS,
    maxBytes = RESIZE_MAX_BYTES,
    fetchImpl = globalThis.fetch,
  }: {
    timeoutMs?: number;
    maxBytes?: number;
    fetchImpl?: typeof globalThis.fetch;
  } = {}
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return null;
    }

    if (!response.body) {
      // No stream to meter (a mocked or non-streaming response): fall back to
      // buffering, then check. Bounded by the declared length above where present.
      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer.byteLength > maxBytes ? null : buffer;
    }

    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.abort();
        return null;
      }
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  } catch (err) {
    console.warn('Could not fetch image from URL: ' + err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
