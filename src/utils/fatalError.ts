/**
 * The fatal-error contract between providers and the server's boot.
 *
 * The server isolates provider failures: a provider constructor, a backend
 * module load or a boot hook that throws is logged with the package name and
 * boot carries on without that provider. That is right for a bug, and wrong
 * for a provider that has decided the app must not serve at all — auth with
 * no signing secret in production, say. Serving anyway looks healthy and
 * fails every request that needs it.
 *
 * So: an error with an OWN property `fatal` set to `true` is not swallowed
 * when it is thrown at boot. The server logs it, `start()` rejects with it,
 * and the process exits non-zero. Any error object qualifies — a provider
 * does not need to depend on this package to use the contract:
 *
 *   throw Object.assign(new Error('JWT_SECRET is not set'), {fatal: true});
 *
 * or, with this package available:
 *
 *   throw new FatalStartupError('JWT_SECRET is not set');
 *
 * Thrown after boot (a per-request hook, a lazy load on a later /call, an
 * HMR reload) it is logged as fatal but does not stop a running server.
 */
export interface FatalError extends Error {
  fatal: true;
}

/** An error that refuses to let the server start. See {@link FatalError}. */
export class FatalStartupError extends Error implements FatalError {
  fatal: true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    // `cause` by hand: the ES2022 Error(message, options) signature is not in
    // this package's lib target.
    if (options && 'cause' in options) (this as any).cause = options.cause;
    this.name = 'FatalStartupError';
    // Assigned, not declared with an initializer, so it is an own property
    // whatever the class-field emit.
    this.fatal = true;
  }
}

/** True for an error that carries the fatal contract: own `fatal === true`. */
export function isFatalError(err: unknown): err is FatalError {
  return (
    !!err &&
    typeof err === 'object' &&
    Object.prototype.hasOwnProperty.call(err, 'fatal') &&
    (err as any).fatal === true
  );
}
