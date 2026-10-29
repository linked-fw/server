/**
 * The host→app control channel: `/admin/*` routes a host uses on an app process it
 * started. Present only when the process was started with a shared secret in
 * `APP_ADMIN_SECRET` (see {@link resolveAdminSecret}); without it every route answers
 * 404, so a standalone app has no control channel. Every request carries the secret in
 * the `x-app-admin-secret` header (401 otherwise).
 *
 * - `GET /admin/health` → 200 `{status: 'ok'}` once the server listens (a boot sync, when
 *   the app writes its own graphs, has finished by then).
 * - `POST /admin/restart` → 202, then the process exits; the host starts it again.
 * - `POST /admin/graph-registry-changed` `{dataset}` → the host changed the named graphs of that
 *   dataset (a graph query through its gateway): the process drops its cached graph registry, so
 *   its next `.from(graphs.allOntologies)` read re-reads it, and answers 200
 *   `{invalidated: dataset}`. A body without a dataset name answers 400. Without the push the
 *   cache's 30-second expiry applies.
 * - `POST /admin/graph-content` `{packages?, reload?}` → 200 {@link GraphContentAnswer}: what the
 *   app's `'package'`-mode syncs would write for each package (its shape graph's Turtle, its
 *   ontology graph's N-Triples, the hash each record gets, its sources) and for the app's own shape
 *   graph, writing nothing. A host that writes the app's graphs itself (`LINKED_GRAPH_WRITER=host`)
 *   reads them here. `reload` names packages whose source changed on disk: in dev they are
 *   reloaded first (their modules invalidated in Vite, their backends reloaded, their ontologies
 *   registered again and the shape check run), so the answer holds shapes added or changed since
 *   the boot; a built app reloads nothing. Each name must be a valid npm package name and the app
 *   itself or one of its direct dependencies, never an `@_linked/*` framework package. `packages`
 *   limits the answer. One request at a time, as the system; one that takes longer than
 *   `LINKED_SHAPE_SYNC_TIMEOUT_MS` fails with 500 and releases the queue. 400 for a malformed body
 *   or a package it may not reload; 409 when a graph target is not `'package'`.
 * - `GET /admin/routes` → 200 {@link EffectiveRoutes}: the graph routes of every dataset the
 *   router knows (shape IRI → graph IRI) and the shapes each one writes to its default graph,
 *   as core's routing holds them once the app's storage file has run. The routes are written
 *   only in the app's storage file; this route lets a host check what actually runs.
 */
import { createHash, timingSafeEqual } from 'crypto';
import type express from 'express';
import { invalidateGraphRegistry } from '@_linked/core/utils/graphRegistryCache';
import type { GraphContents } from './syncShapes.js';
import type { GraphTargets } from '@_linked/core/utils/graphTargets';
import { effectiveGraphRoutes, type EffectiveRoutes } from './effectiveRoutes.js';

/** The environment variable that holds the control channel's secret. */
export const ADMIN_SECRET_ENV = 'APP_ADMIN_SECRET';
/** The request header that carries the secret. */
export const ADMIN_SECRET_HEADER = 'x-app-admin-secret';

/** The control channel's secret: `APP_ADMIN_SECRET`, else `undefined` (no control channel). */
export function resolveAdminSecret(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env[ADMIN_SECRET_ENV] || undefined;
}

/** npm's package-name rule: optional `@scope/`, lower case, URL-safe, no leading `.` or `_` (a scope may start with `_`, as `@_linked` does). */
const NPM_NAME = /^(?:@[a-z0-9-~_][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Whether `name` is a valid npm package name (and so can never be a path like `..`). */
export function isValidPackageName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name) && !name.split('/').some((part) => part === '.' || part === '..');
}

/**
 * Refuse a package a host may not ask to reload: not a valid npm name, a framework
 * (`@_linked/*`) package, or not in `allowed` (the app's own name and its direct
 * dependencies, its `linked.unpublishedPackages` among them). Throws {@link AdminRequestError}.
 */
export function assertReloadablePackages(packages: string[], allowed: ReadonlySet<string>): void {
  for (const pkg of packages) {
    if (!isValidPackageName(pkg)) throw new AdminRequestError(`not a package name: ${JSON.stringify(pkg)}`);
    if (pkg.startsWith('@_linked/')) throw new AdminRequestError(`framework packages are not reloaded: ${pkg}`);
    if (!allowed.has(pkg)) {
      throw new AdminRequestError(`unknown package: ${pkg} is neither the app nor one of its direct dependencies (dependencies, devDependencies, linked.unpublishedPackages)`);
    }
  }
}

/** Thrown by a handler for a request the channel refuses with 400. */
export class AdminRequestError extends Error {}

/** Thrown by a handler for a request that conflicts with how the process runs: answered 409. */
export class AdminConflictError extends Error {}

/** The answer of `POST /admin/graph-content`. */
export interface GraphContentAnswer extends GraphContents {
  /** The process's graph targets (both `'package'`, or the route answers 409). */
  graphTargets: GraphTargets;
  /** The requested packages whose source was reloaded first (dev only). */
  reloaded: string[];
}

/** The body of a graph-content request: `packages` limits the answer, `reload` is reloaded first. */
export function parseGraphContentBody(body: unknown): { packages?: string[]; reload: string[] } {
  if (body === undefined || body === null || body === '') return { reload: [] };
  if (typeof body !== 'object' || Array.isArray(body)) throw new AdminRequestError('the body must be a JSON object');
  const names = (field: 'packages' | 'reload'): string[] | undefined => {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((p) => typeof p !== 'string' || !p)) {
      throw new AdminRequestError(`${field} must be a list of package names`);
    }
    for (const p of value as string[]) {
      if (!isValidPackageName(p)) throw new AdminRequestError(`not a package name: ${JSON.stringify(p)}`);
    }
    return [...new Set(value as string[])];
  };
  const packages = names('packages');
  return { ...(packages ? { packages } : {}), reload: names('reload') ?? [] };
}

export interface AdminChannelHandlers {
  /** Exit the process (the host restarts it). Called after the 202 is sent. */
  exit: () => void;
  /**
   * Drop the cached graph registry for `dataset` (see `POST /admin/graph-registry-changed`).
   * Default: {@link dropGraphRegistryCache}.
   */
  graphRegistryChanged?: (dataset: string) => void;
  /** The effective graph routes (see `GET /admin/routes`). Default: {@link effectiveGraphRoutes}. */
  routes?: () => EffectiveRoutes;
  /** Reload `reload`, then answer the content of the app's graphs (see `POST /admin/graph-content`); without it the route answers 404. */
  graphContent?: (request: { packages?: string[]; reload: string[] }) => Promise<GraphContentAnswer>;
}

/**
 * Drop the process's cached graph registry after the host changed the graphs of `dataset`.
 *
 * Every entry is dropped, not only that dataset's: an entry's key is each store's own
 * (`graphRegistryKey()`: a `FusekiStore` keys by its dataset URL, a `RemoteDataset` by the
 * dataset its server names), no store tells which key it uses, and the stores are built by the
 * app's storage config, whose aliases the server does not see. The registry is small, so the cost
 * is one registry read per dataset on its next expanding read.
 */
export function dropGraphRegistryCache(_dataset: string): void {
  invalidateGraphRegistry();
}

/** The `dataset` of a graph-registry-changed body: a non-empty name. */
export function parseGraphRegistryChangedBody(body: unknown): { dataset: string } {
  const dataset = body && typeof body === 'object' ? (body as { dataset?: unknown }).dataset : undefined;
  if (typeof dataset !== 'string' || !dataset.trim() || dataset.length > 1024) {
    throw new AdminRequestError('dataset must be the name of the dataset whose graphs changed');
  }
  return { dataset: dataset.trim() };
}

/**
 * Compare the provided secret with the configured one in constant time. Both sides are hashed
 * first, so the comparison does not reveal the secret's length either.
 */
export function adminSecretMatches(
  secret: string | undefined,
  provided: string | undefined
): boolean {
  if (!secret || !provided) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(secret));
}

/** Mount the control channel's routes on `app`. */
export function registerAdminRoutes(
  app: express.Express,
  secret: string | undefined,
  handlers: AdminChannelHandlers
): void {
  const requireAdmin = (req: express.Request, res: express.Response): boolean => {
    if (!secret) {
      res.sendStatus(404); // no control channel in this mode
      return false;
    }
    if (!adminSecretMatches(secret, req.get(ADMIN_SECRET_HEADER))) {
      res.sendStatus(401);
      return false;
    }
    return true;
  };

  app.get('/admin/health', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.status(200).json({ status: 'ok' });
  });

  app.post('/admin/restart', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.sendStatus(202);
    setTimeout(handlers.exit, 50);
  });

  app.get('/admin/routes', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.status(200).json((handlers.routes ?? effectiveGraphRoutes)());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/admin/graph-registry-changed', (req, res) => {
    if (!requireAdmin(req, res)) return;
    let dataset: string;
    try {
      ({ dataset } = parseGraphRegistryChangedBody(req.body));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    (handlers.graphRegistryChanged ?? dropGraphRegistryCache)(dataset);
    res.status(200).json({ invalidated: dataset });
  });

  app.post('/admin/graph-content', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!handlers.graphContent) {
      res.sendStatus(404);
      return;
    }
    let request: { packages?: string[]; reload: string[] };
    try {
      request = parseGraphContentBody(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      res.status(200).json(await handlers.graphContent(request));
    } catch (err) {
      const status = err instanceof AdminRequestError ? 400 : err instanceof AdminConflictError ? 409 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
