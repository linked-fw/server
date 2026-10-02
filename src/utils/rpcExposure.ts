/**
 * Which provider methods a `/call/...` request may reach.
 *
 * A provider method is dispatched over HTTP only when the provider's own class
 * declares it with `@callable(level)` (or `declareCallable`) from
 * `@_linked/server-utils/utils/callable`. TypeScript `private`/`protected` do not
 * exist at runtime, so without a declaration every method of a provider would be
 * reachable, including everything it inherits.
 *
 * - **reserved** — never dispatched, in any mode: `Object.prototype` members,
 *   every `BackendProvider`/`ShapeProvider` method (`initRequest`,
 *   `registerRoute`, lifecycle hooks, ...), even when a subclass overrides it,
 *   `constructor`, `__proto__`, and anything that is not a plain function
 *   (accessors, fields). Answered 501, exactly like a missing method.
 * - **undeclared** — a method of the provider itself without a declaration.
 *   In `warn` mode it runs and is logged once; in `enforce` mode it is 501.
 * - **callable** — declared. A `'user'` method answers 401 without a session.
 *
 * Backend-to-backend calls (`Server.call` on the server) skip everything except
 * the reserved names.
 */
import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';
import {
  getOwnCallableLevel,
  type CallableLevel,
} from '@_linked/server-utils/utils/callable';

export type RpcExposureMode = 'warn' | 'enforce';

export type CallableResolution =
  | { status: 'callable'; level: CallableLevel; owner: Function }
  | { status: 'undeclared'; owner: Function | undefined }
  | { status: 'reserved' }
  | { status: 'missing' };

function ownNames(proto: object | undefined): string[] {
  return proto ? Object.getOwnPropertyNames(proto) : [];
}

let reservedNames: Set<string> | undefined;

/**
 * Names no RPC may dispatch to. Computed on first use (not at import), so the
 * base classes are fully defined, and including every method they have.
 */
export function getReservedNames(): ReadonlySet<string> {
  if (!reservedNames) {
    reservedNames = new Set([
      ...ownNames(Object.prototype),
      ...ownNames(BackendProvider.prototype),
      ...ownNames(ShapeProvider.prototype),
      'constructor',
      '__proto__',
    ]);
  }
  return reservedNames;
}

function isBaseClassPrototype(obj: object): boolean {
  return (
    obj === Object.prototype ||
    obj === BackendProvider.prototype ||
    obj === ShapeProvider.prototype
  );
}

/**
 * Decide whether `method` of `provider` may be dispatched.
 *
 * Walks the prototype chain with property descriptors only, so no getter ever
 * runs. The first object that owns the name decides: if it is a class
 * prototype, that class's own declaration; if it is the instance itself (a
 * method assigned onto the instance), there is no declaration.
 */
export function resolveCallable(provider: any, method: string): CallableResolution {
  if (typeof method !== 'string' || !method) return { status: 'missing' };
  if (provider == null || (typeof provider !== 'object' && typeof provider !== 'function')) {
    return { status: 'missing' };
  }
  const reserved = getReservedNames();
  let obj: any = provider;
  let descriptor: PropertyDescriptor | undefined;
  let holder: any;
  while (obj) {
    descriptor = Object.getOwnPropertyDescriptor(obj, method);
    if (descriptor) {
      holder = obj;
      break;
    }
    obj = Object.getPrototypeOf(obj);
  }
  if (!descriptor) {
    return reserved.has(method) ? { status: 'reserved' } : { status: 'missing' };
  }
  if (reserved.has(method) || isBaseClassPrototype(holder)) {
    return { status: 'reserved' };
  }
  if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
    return { status: 'reserved' };
  }
  const holderCtor = Object.prototype.hasOwnProperty.call(holder, 'constructor')
    ? holder.constructor
    : undefined;
  const isClassPrototype =
    typeof holderCtor === 'function' && holderCtor.prototype === holder;
  if (!isClassPrototype) {
    // A method assigned onto the instance itself: nothing declares it.
    return { status: 'undeclared', owner: provider?.constructor };
  }
  const level = getOwnCallableLevel(holderCtor, method);
  return level
    ? { status: 'callable', level, owner: holderCtor }
    : { status: 'undeclared', owner: holderCtor };
}

/**
 * True when the provider's own class opts out of the generic `/call/<pkg>/...`
 * route with `static rpc = false`. Only the provider's own class counts.
 */
export function isGenericRpcDisabled(provider: any): boolean {
  const cls = provider?.constructor;
  return (
    typeof cls === 'function' &&
    Object.prototype.hasOwnProperty.call(cls, 'rpc') &&
    (cls as any).rpc === false
  );
}

let configuredMode: RpcExposureMode | undefined;

function parseMode(value: unknown): RpcExposureMode | undefined {
  return value === 'warn' || value === 'enforce' ? value : undefined;
}

/**
 * Set from the server's config (`server.rpcExposure`). An invalid value is
 * ignored with a warning, leaving the environment / default in place.
 */
export function setRpcExposureMode(mode: unknown): void {
  if (mode === undefined || mode === null) {
    configuredMode = undefined;
    return;
  }
  const parsed = parseMode(mode);
  if (!parsed) {
    console.warn(
      `[linked] server.rpcExposure must be 'warn' or 'enforce', got ${JSON.stringify(mode)}; ignoring it`
    );
    return;
  }
  configuredMode = parsed;
}

/** `server.rpcExposure`, else `LINKED_RPC_EXPOSURE`, else `'warn'`. */
export function getRpcExposureMode(): RpcExposureMode {
  return configuredMode ?? parseMode(process.env.LINKED_RPC_EXPOSURE) ?? 'warn';
}

const warnedUndeclared = new Set<string>();

/** Log an undeclared call once per package, class and method. */
export function warnUndeclaredCall(
  pkg: string,
  owner: Function | undefined,
  method: string,
  hasSession: boolean
): void {
  const className = owner?.name || 'anonymous provider';
  const key = `${pkg}\u0000${className}\u0000${method}`;
  if (warnedUndeclared.has(key)) return;
  warnedUndeclared.add(key);
  console.warn(
    `[linked] undeclared RPC ${pkg} ${className}.${method} (session: ${hasSession ? 'yes' : 'no'}). ` +
      `Declare it with @callable('public' | 'user') if the client calls it; ` +
      `undeclared methods are refused (501) once rpcExposure is 'enforce'.`
  );
}

/** For tests: forget which undeclared calls were already logged. */
export function resetUndeclaredWarnings(): void {
  warnedUndeclared.clear();
}
