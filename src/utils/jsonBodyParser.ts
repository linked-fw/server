import express from 'express';

/**
 * Largest JSON body the server accepts. `Server.call` sends its arguments as
 * one JSON document, and some callers (bulk imports, base64 file payloads)
 * send far more than the 100kb default.
 */
export const JSON_BODY_LIMIT = '50mb';

/**
 * The request body parser LinkedServer mounts in front of every route.
 *
 * It is Express's own `express.json()`, i.e. the body-parser 1.x that ships
 * inside Express 4 — the server does not depend on body-parser directly. It
 * parses `application/json` only: multipart uploads (handled with formidable
 * by the upload utilities) and urlencoded forms pass through with their stream
 * unread. Changing parser, or moving to Express 5 (body-parser 2), must keep
 * the behaviour pinned by `json-body-parser.test.ts`.
 */
export function createJsonBodyParser() {
  return express.json({ limit: JSON_BODY_LIMIT, verify: keepRawBody });
}

/** The routes whose handlers get the body as received, on `request.rawBody`. */
const RAW_BODY_PATHS = new Set(['/api/select-raw']);

/**
 * Keep the unparsed bytes of a raw SPARQL request on `request.rawBody`, so a
 * raw query authorizer (`registerRawQueryAuthorizer` in server-utils) can
 * verify a signature over the exact body. Only for those routes: every other
 * body is parsed and its bytes dropped as before.
 */
function keepRawBody(req: any, _res: unknown, buf: Buffer) {
  const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
  if (req.method === 'POST' && RAW_BODY_PATHS.has(path)) {
    req.rawBody = buf;
  }
}
