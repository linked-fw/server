/**
 * The host→app control channel: `/admin/*` routes a host (Create Now) uses on an
 * app process it started. Present only when the process was started with a
 * shared secret in `CN_APP_ADMIN_SECRET`; without it every route answers 404, so
 * a standalone app has no control channel. Every request carries the secret in
 * the `x-cn-admin-secret` header.
 *
 * - `GET /admin/health` → 200 `{status: 'ok'}` once the server listens (the boot
 *   shape sync has finished by then).
 * - `POST /admin/restart` → 202, then the process exits; the host starts it again.
 * - `POST /admin/sync-shapes` → re-syncs the app's shapes into its app data, as
 *   the boot does, and answers 200 with {@link ShapeSyncResult}. Body (optional):
 *   `{packages: string[]}`, packages whose source changed on disk: in dev they are
 *   reloaded first, so the sync sees shapes added or changed since the boot. Each
 *   name must be a valid npm package name and the app itself or one of its direct
 *   dependencies, never an `@_linked/*` framework package; anything else answers
 *   400 `{error}`. A failed or timed-out sync answers 500 `{error}`.
 */
import { timingSafeEqual } from 'crypto';
import type express from 'express';

/** What one shape sync did. */
export interface ShapeSyncResult {
  /** Shapes written: those whose stored hash differed from the registered shape. */
  written: number;
  /** The orphan policy the sync ran with (see utils/syncShapes). */
  orphanScope?: 'all' | 'none';
  /** Set when no sync ran: shape sync is turned off, or there is no default dataset. */
  skipped?: 'disabled' | 'no-default-dataset';
  /**
   * The requested packages whose source was reloaded before the sync (dev only: a built
   * app reloads nothing). Set by `POST /admin/sync-shapes`.
   */
  reloaded?: string[];
  /** The node shape IRIs registered in the process after the reload. Set by `POST /admin/sync-shapes`. */
  shapes?: string[];
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
 * dependencies). Throws {@link AdminRequestError}.
 */
export function assertReloadablePackages(packages: string[], allowed: ReadonlySet<string>): void {
  for (const pkg of packages) {
    if (!isValidPackageName(pkg)) throw new AdminRequestError(`not a package name: ${JSON.stringify(pkg)}`);
    if (pkg.startsWith('@_linked/')) throw new AdminRequestError(`framework packages are not reloaded: ${pkg}`);
    if (!allowed.has(pkg)) {
      throw new AdminRequestError(`unknown package: ${pkg} is neither the app nor one of its direct dependencies`);
    }
  }
}

/** Thrown by a handler for a request the channel refuses with 400. */
export class AdminRequestError extends Error {}

export interface AdminChannelHandlers {
  /** Exit the process (the host restarts it). Called after the 202 is sent. */
  exit: () => void;
  /** Reload `packages` (when given) and sync the registered shapes into app data. */
  syncShapes: (request: { packages: string[] }) => Promise<ShapeSyncResult>;
}

/** Compare the provided secret with the configured one in constant time. */
export function adminSecretMatches(
  secret: string | undefined,
  provided: string | undefined
): boolean {
  if (!secret || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The `packages` of a sync-shapes body: a list of package names, or none. */
export function parseSyncShapesBody(body: unknown): { packages: string[] } {
  if (body === undefined || body === null || body === '') return { packages: [] };
  if (typeof body !== 'object') {
    throw new AdminRequestError('the body must be a JSON object');
  }
  const packages = (body as { packages?: unknown }).packages;
  if (packages === undefined) return { packages: [] };
  if (!Array.isArray(packages) || packages.some((p) => typeof p !== 'string' || !p)) {
    throw new AdminRequestError('packages must be a list of package names');
  }
  for (const p of packages as string[]) {
    if (!isValidPackageName(p)) throw new AdminRequestError(`not a package name: ${JSON.stringify(p)}`);
  }
  return { packages: [...new Set(packages as string[])] };
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
    if (!adminSecretMatches(secret, req.get('x-cn-admin-secret'))) {
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

  app.post('/admin/sync-shapes', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    let request: { packages: string[] };
    try {
      request = parseSyncShapesBody(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      res.status(200).json(await handlers.syncShapes(request));
    } catch (err) {
      const status = err instanceof AdminRequestError ? 400 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
