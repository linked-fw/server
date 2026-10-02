/**
 * Which provider methods a `/call/...` request may reach.
 *
 * A provider method is dispatched over HTTP when it is declared with
 * `@callable(level)` (or `declareCallable`) from
 * `@_linked/server-utils/utils/callable`. TypeScript `private`/`protected` do not
 * exist at runtime, so without a declaration every method of a provider would be
 * reachable, including everything it inherits.
 *
 * The class that owns the method (the first prototype on the chain that has it)
 * decides. When that class declares it, its own level applies. When it does not
 * (an override of an inherited method), the method keeps the strictest level
 * declared for it by any class up the chain (`'user'` over `'public'`), so an
 * override never loses a session requirement. Only when no class declares it is
 * the method undeclared.
 *
 * - **reserved** — never dispatched, in any mode: `Object.prototype` members,
 *   every `BackendProvider`/`ShapeProvider` method (`initRequest`,
 *   `registerRoute`, lifecycle hooks, ...), even when a subclass overrides it,
 *   `dispose` (a lifecycle hook the server calls on reload, which the base
 *   class does not define), `constructor`, `__proto__`, and anything that is not
 *   a plain function (accessors, fields). Answered 501, exactly like a missing
 *   method.
 * - **internal** — declared with `@internal()` / `declareInternal` by the
 *   provider's class or one of its super classes (an app can declare it on a
 *   class it imports). Never dispatched over HTTP, in any mode (501), even when
 *   it is also declared callable. Backend-to-backend calls still reach it.
 * - **undeclared** — no class on the chain declares it. In `warn` mode it runs
 *   and is logged once; in `enforce` mode it is 501.
 * - **callable** — declared (directly or inherited, see above). A `'user'`
 *   method answers 401 without a session.
 *
 * Backend-to-backend calls (`Server.call` on the server) skip everything except
 * the reserved names, internal methods included.
 */
import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';
import {
  getOwnCallableLevel,
  isDeclaredInternal,
  type CallableLevel,
} from '@_linked/server-utils/utils/callable';

export type RpcExposureMode = 'warn' | 'enforce';

export type CallableResolution =
  | { status: 'callable'; level: CallableLevel; owner: Function; inherited?: boolean }
  | { status: 'undeclared'; owner: Function | undefined }
  | { status: 'internal'; owner: Function | undefined }
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
      // called by the server when it reloads providers; no base class defines it
      'dispose',
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
  // Internal on the provider's class or any super class wins over everything
  // else, a callable declaration included.
  const providerCtor = typeof provider === 'function' ? undefined : provider.constructor;
  if (
    (typeof providerCtor === 'function' && isDeclaredInternal(providerCtor, method)) ||
    (isClassPrototype && isDeclaredInternal(holderCtor, method))
  ) {
    return { status: 'internal', owner: isClassPrototype ? holderCtor : providerCtor };
  }
  if (isClassPrototype) {
    const own = getOwnCallableLevel(holderCtor, method);
    if (own) return { status: 'callable', level: own, owner: holderCtor };
  }
  // Not declared where it is defined (an override, or a method assigned onto
  // the instance): the strictest level declared up the class chain applies.
  const start = isClassPrototype ? holderCtor : providerCtor;
  const inherited = strictestDeclaredLevel(start, method);
  if (inherited) {
    return { status: 'callable', level: inherited, owner: start, inherited: true };
  }
  return { status: 'undeclared', owner: start };
}

const STRICTNESS: Record<CallableLevel, number> = { public: 0, user: 1 };

/** The strictest level any class from `cls` up declares for `method`. */
function strictestDeclaredLevel(cls: unknown, method: string): CallableLevel | undefined {
  let level: CallableLevel | undefined;
  let c: any = cls;
  while (typeof c === 'function' && c !== Function.prototype) {
    const own = getOwnCallableLevel(c, method);
    if (own && (level === undefined || STRICTNESS[own] > STRICTNESS[level])) level = own;
    c = Object.getPrototypeOf(c);
  }
  return level;
}

/**
 * A client-supplied name made safe for a log line: control characters escaped
 * (no forged lines or terminal escapes), and cut to a bounded length.
 */
export function logSafe(value: unknown, max = 120): string {
  const text = String(value);
  const escaped = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
  );
  return escaped.length > max ? escaped.slice(0, max) + '…' : escaped;
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
    `[linked] undeclared RPC ${logSafe(pkg)} ${className}.${logSafe(method)} (session: ${hasSession ? 'yes' : 'no'}). ` +
      `Declare it with @callable('public' | 'user') if the client calls it; ` +
      `undeclared methods are refused (501) once rpcExposure is 'enforce'.`
  );
}

/** For tests: forget which undeclared calls were already logged. */
export function resetUndeclaredWarnings(): void {
  warnedUndeclared.clear();
}
