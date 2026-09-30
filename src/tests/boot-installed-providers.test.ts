import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { LinkedServer } from '../shapes/LinkedServer.js';
import {
  discoverLinkedDependencies,
  isBundledBySsr,
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

function installPackage(name: string, json: object, backend?: string) {
  writeFile(
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version: '1.0.0', type: 'module', ...json })
  );
  if (backend) writeFile(`node_modules/${name}/lib/esm/backend.js`, backend);
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
      dependencies: {
        '@_linked/fixture-auth': '1.0.0',
        'custom-linked': '1.0.0',
        'plain-lib': '1.0.0',
        'legacy-lincd': '1.0.0',
      },
    })
  );
  // Scope alone qualifies; its dependency is reached transitively.
  installPackage(
    '@_linked/fixture-auth',
    { dependencies: { '@_linked/fixture-nested': '1.0.0' } },
    providerSource('auth')
  );
  installPackage('@_linked/fixture-nested', {}, providerSource('nested'));
  // A custom scope qualifies through the flag.
  installPackage('custom-linked', { linkedPackage: true }, providerSource('custom'));
  // Neither of these may be loaded at boot.
  installPackage('plain-lib', {}, providerSource('plain'));
  installPackage('legacy-lincd', { lincd: true }, providerSource('legacy'));
  // The app's own compiled backend, so loading it is quiet.
  writeFile('lib/backend.js', 'export {};\n');
  process.chdir(appDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(appDir, { recursive: true, force: true });
});

// Resolves `<pkg>/backend` inside the fixture app, the way Node resolves it
// from the app's node_modules in a real install. The test runner would resolve
// a bare specifier relative to LinkedServer's source file instead.
async function importFromApp(specifier: string) {
  const match = specifier.match(/^((?:@[^/]+\/)?[^/]+)\/backend$/);
  const file = match
    ? path.join(appDir, 'node_modules', match[1], 'lib', 'esm', 'backend.js')
    : null;
  if (!file || !fs.existsSync(file)) {
    const err: any = new Error(`Cannot find module '${specifier}'`);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return import(pathToFileURL(file).href);
}

function makeServer(vite?: any): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.genericProviders = new Map();
  server.shapeProviders = new Map();
  server.providerIndexing = new Map();
  server.package = JSON.parse(
    fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8')
  );
  server.config = { server: vite ? { vite } : {} };
  server.importModule = importFromApp;
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

  it('loads only @_linked/* and linkedPackage-flagged packages', async () => {
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
      ssrLoadModule: async (id: string) => {
        viaVite.push(id);
        return importFromApp(id);
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
