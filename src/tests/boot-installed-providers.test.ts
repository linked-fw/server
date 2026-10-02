import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { LinkedServer } from '../shapes/LinkedServer.js';
import {
  discoverLinkedDependencies,
  isBundledBySsr,
  resolveBackendEntry,
} from '../utils/linkedDependencies.js';

// A package INSTALLED into the app's node_modules (a real directory, not a
// workspace member) whose backend provider hooks every page request through
// supplyDataForRequest. This is the shape of a registry-installed
// @_linked/auth: its provider must be indexed at boot, or the first page after
// a restart ships request data without it.

let appDir: string;
let originalCwd: string;
const g = globalThis as any;

function writeFile(rel: string, contents: string) {
  const file = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

// The exports map every linked package ships: `./*` → `./lib/esm/*.js`.
const LINKED_EXPORTS = {
  '.': { types: './lib/esm/index.d.ts', import: './lib/esm/index.js' },
  './*.js': { types: './lib/esm/*.d.ts', import: './lib/esm/*.js' },
  './*': { types: './lib/esm/*.d.ts', import: './lib/esm/*.js' },
};

/**
 * Install a package into a real node_modules layout. `under` nests it inside
 * another installed package's own node_modules (`node_modules/<under>/node_modules/<name>`),
 * the way npm installs a version the root cannot share.
 */
function installPackage(
  name: string,
  json: object,
  backend?: string,
  under?: string
) {
  const root = under
    ? `node_modules/${under}/node_modules/${name}`
    : `node_modules/${name}`;
  writeFile(
    `${root}/package.json`,
    JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      main: 'lib/esm/index.js',
      exports: LINKED_EXPORTS,
      ...json,
    })
  );
  writeFile(`${root}/lib/esm/index.js`, 'export {};\n');
  if (backend) writeFile(`${root}/lib/esm/backend.js`, backend);
}

const providerSource = (label: string) => `
globalThis.__constructed = globalThis.__constructed || {};
export default class Provider {
  constructor() {
    globalThis.__constructed[${JSON.stringify(label)}] =
      (globalThis.__constructed[${JSON.stringify(label)}] || 0) + 1;
  }
  initRequest() {}
  supplyDataForRequest(request) {
    request.frontendData[${JSON.stringify(label)}] = 'supplied';
  }
  ping() { return 'pong'; }
}
`;

beforeEach(() => {
  originalCwd = process.cwd();
  appDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'linked-boot-providers-'))
  );
  g.__constructed = {};
  writeFile(
    'package.json',
    JSON.stringify({
      name: 'fixture-app',
      type: 'module',
      dependencies: {
        '@_linked/fixture-auth': '1.0.0',
        'custom-linked': '1.0.0',
        'plain-lib': '1.0.0',
        'legacy-lincd': '1.0.0',
        '@_linked/unflagged-tool': '1.0.0',
      },
    })
  );
  // The "linkedPackage": true flag qualifies; a flagged dependency is reached
  // transitively.
  installPackage(
    '@_linked/fixture-auth',
    { linkedPackage: true, dependencies: { '@_linked/fixture-nested': '1.0.0' } },
    providerSource('auth')
  );
  installPackage('@_linked/fixture-nested', { linkedPackage: true }, providerSource('nested'));
  // An unscoped package qualifies through the flag too.
  installPackage('custom-linked', { linkedPackage: true }, providerSource('custom'));
  // None of these may be loaded at boot: no flag, the legacy flag only, and
  // the @_linked scope without the flag (a CLI tool like @_linked/localize).
  installPackage('plain-lib', {}, providerSource('plain'));
  installPackage('legacy-lincd', { lincd: true }, providerSource('legacy'));
  installPackage('@_linked/unflagged-tool', {}, providerSource('unflagged'));
  // The app's own compiled backend, so loading it is quiet.
  writeFile('lib/backend.js', 'export {};\n');
  process.chdir(appDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(appDir, { recursive: true, force: true });
});

// No stand-in for module resolution: the server resolves each backend from
// the package directory discovery found, and imports it by file URL.

function makeServer(vite?: any): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.genericProviders = new Map();
  server.shapeProviders = new Map();
  server.providerIndexing = new Map();
  server.package = JSON.parse(
    fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8')
  );
  server.linkedPackageDirs = new Map();
  server.warnedDuplicateInstalls = new Set();
  server.config = { server: vite ? { vite } : {} };
  return server;
}

describe('boot indexes installed linked packages', () => {
  it("an installed package's supplyDataForRequest runs on the first request", async () => {
    const server = makeServer();
    await server.initBackendProviders();

    const request: any = { frontendData: {} };
    const { requestObject } = await server.getRequestData(request, {});

    expect(JSON.parse(requestObject)).toEqual({
      auth: 'supplied',
      nested: 'supplied',
      custom: 'supplied',
    });
  });

  it('loads only linkedPackage-flagged packages, whatever their scope', async () => {
    const server = makeServer();
    await server.initBackendProviders();
    expect(Object.keys(g.__constructed).sort()).toEqual(['auth', 'custom', 'nested']);
  });

  it('indexes a package after the linked packages it depends on', async () => {
    // Indexing order is the order setupBeforeControllers registers middleware.
    const server = makeServer();
    await server.initBackendProviders();
    const order = [...server.genericProviders.entries()]
      .filter(([, provider]) => provider)
      .map(([name]) => name);
    expect(order).toEqual([
      '@_linked/fixture-nested',
      '@_linked/fixture-auth',
      'custom-linked',
    ]);
  });

  it('a /call after boot, and concurrent first calls, construct a provider once', async () => {
    const server = makeServer();
    await Promise.all([
      server.ensurePackageBackendProviders('plain-lib'),
      server.ensurePackageBackendProviders('plain-lib'),
    ]);
    expect(g.__constructed.plain).toBe(1);

    await server.initBackendProviders();
    const result = await server.callBackendMethod(
      '@_linked/fixture-auth',
      'ping',
      [],
      {},
      {}
    );
    expect(result).toBe('pong');
    expect(g.__constructed.auth).toBe(1);
  });

  it('in dev, loads an installed package with Node, not Vite', async () => {
    const viaVite: string[] = [];
    const vite = {
      config: { ssr: { noExternal: ['@_linked/fixture-nested'] } },
      pluginContainer: { resolveId: async (id: string) => ({ id }) },
      // Stands in for Vite resolving a bundled package's bare specifier.
      ssrLoadModule: async (id: string) => {
        viaVite.push(id);
        const name = id.replace(/\/backend$/, '');
        const root = path.join(appDir, 'node_modules', name);
        const json = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
        return import(pathToFileURL(resolveBackendEntry(root, json)!).href);
      },
    };
    const server = makeServer(vite);
    await server.initBackendProviders();

    // The bundled one goes through Vite; the external ones do not.
    expect(viaVite).toContain('@_linked/fixture-nested/backend');
    expect(viaVite).not.toContain('@_linked/fixture-auth/backend');
    expect(viaVite).not.toContain('custom-linked/backend');
    expect(g.__constructed.auth).toBe(1);
  });
});

const throwingProviderSource = `
export default class Provider {
  setupBeforeControllers() {
    throw new Error('boom in setup');
  }
  setupAfterControllers() {
    return Promise.reject(new Error('async boom in setup'));
  }
  initRequest() {
    throw new Error('boom in initRequest');
  }
  supplyDataForRequest() {
    throw new Error('boom in supplyDataForRequest');
  }
}
`;

const recordingProviderSource = (label: string) => `
globalThis.__hooks = globalThis.__hooks || [];
export default class Provider {
  setupBeforeControllers() { globalThis.__hooks.push(${JSON.stringify(label)} + ':before'); }
  setupAfterControllers() { globalThis.__hooks.push(${JSON.stringify(label)} + ':after'); }
  initRequest(request) { request.inited = (request.inited || []).concat(${JSON.stringify(label)}); }
  supplyDataForRequest(request) {
    request.frontendData[${JSON.stringify(label)}] = 'supplied';
  }
}
`;

describe('a provider whose hooks throw', () => {
  let errorSpy: any;
  beforeEach(() => {
    g.__hooks = [];
    // The thrower is indexed BEFORE the healthy package that depends on it, so
    // a loop that does not isolate providers never reaches the healthy one.
    writeFile(
      'package.json',
      JSON.stringify({
        name: 'fixture-app',
        type: 'module',
        dependencies: { 'healthy-linked': '1.0.0' },
      })
    );
    installPackage(
      'healthy-linked',
      { linkedPackage: true, dependencies: { '@_linked/fixture-broken': '1.0.0' } },
      recordingProviderSource('healthy')
    );
    installPackage(
      '@_linked/fixture-broken',
      { linkedPackage: true },
      throwingProviderSource
    );
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  const logged = () => errorSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n');

  it('does not abort boot, and the error names the package and the hook', async () => {
    const server = makeServer();
    await server.initBackendProviders();
    await server.callGenericBackendProvidersMethod('setupBeforeControllers');
    await server.callGenericBackendProvidersMethod('setupAfterControllers');

    expect(g.__hooks).toEqual(['healthy:before', 'healthy:after']);
    expect(logged()).toContain(
      '[linked] @_linked/fixture-broken setupBeforeControllers failed: boom in setup'
    );
    expect(logged()).toContain(
      '[linked] @_linked/fixture-broken setupAfterControllers failed: async boom in setup'
    );
  });

  it('per-request hooks still serve the request, naming the failing package', async () => {
    const server = makeServer();
    await server.initBackendProviders();

    const request: any = { frontendData: {} };
    await server.initRequest(request, {});
    const { requestObject } = await server.getRequestData(request, {});

    expect(request.inited).toEqual(['healthy']);
    expect(JSON.parse(requestObject)).toEqual({ healthy: 'supplied' });
    expect(logged()).toContain(
      '[linked] @_linked/fixture-broken initRequest failed: boom in initRequest'
    );
    expect(logged()).toContain(
      '[linked] @_linked/fixture-broken supplyDataForRequest failed: boom in supplyDataForRequest'
    );
  });
});

describe('discoverLinkedDependencies', () => {
  it('lists each linked package after its linked dependencies, and skips the rest', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8'));
    expect(discoverLinkedDependencies(appDir, pkg).map((d) => d.packageName)).toEqual([
      '@_linked/fixture-nested',
      '@_linked/fixture-auth',
      'custom-linked',
    ]);
  });
});

describe('isBundledBySsr', () => {
  it('matches strings by package name, regexps by test, and true as everything', () => {
    expect(isBundledBySsr('@_linked/server', ['@_linked/server'])).toBe(true);
    expect(isBundledBySsr('@_linked/server-utils', ['@_linked/server'])).toBe(false);
    expect(isBundledBySsr('@_linked/react', [/^@_linked\/react$/])).toBe(true);
    expect(isBundledBySsr('anything', true)).toBe(true);
    expect(isBundledBySsr('anything', undefined)).toBe(false);
    expect(isBundledBySsr('anything', [])).toBe(false);
  });
});
