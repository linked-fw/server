import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { LinkedServer } from '../shapes/LinkedServer.js';

// Where a linked package's backend is loaded FROM. Every fixture here is a
// real node_modules layout and nothing stands in for module resolution: the
// server has to find each backend itself. A bare `import('<pkg>/backend')`
// resolves from @_linked/server's own location, which never looks inside
// another package's nested node_modules — the layout npm produces when the
// root cannot share one version (owl/node_modules/@_linked/rdfs).

let appDir: string;
let originalCwd: string;
const g = globalThis as any;

const LINKED_EXPORTS = {
  '.': { types: './lib/esm/index.d.ts', import: './lib/esm/index.js' },
  './*.js': { types: './lib/esm/*.d.ts', import: './lib/esm/*.js' },
  './*': { types: './lib/esm/*.d.ts', import: './lib/esm/*.js' },
};

function writeFile(rel: string, contents: string) {
  const file = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** `under` installs it in that package's own node_modules. Returns its root. */
function install(
  name: string,
  opts: {
    version?: string;
    under?: string;
    backend?: string;
    deps?: Record<string, string>;
    exports?: any;
  } = {}
): string {
  const root = opts.under
    ? `node_modules/${opts.under}/node_modules/${name}`
    : `node_modules/${name}`;
  writeFile(
    `${root}/package.json`,
    JSON.stringify({
      name,
      version: opts.version ?? '1.0.0',
      type: 'module',
      linkedPackage: true,
      main: 'lib/esm/index.js',
      exports: opts.exports ?? LINKED_EXPORTS,
      dependencies: opts.deps ?? {},
    })
  );
  writeFile(`${root}/lib/esm/index.js`, 'export {};\n');
  if (opts.backend) writeFile(`${root}/lib/esm/backend.js`, opts.backend);
  return path.join(appDir, root);
}

function writeApp(dependencies: Record<string, string>) {
  writeFile(
    'package.json',
    JSON.stringify({ name: 'fixture-app', type: 'module', dependencies })
  );
}

// Counts module EVALUATIONS (top level) separately from constructions, so a
// second copy of the module is visible even if nobody constructs from it.
const providerSource = (label: string) => `
globalThis.__evaluated[${JSON.stringify(label)}] =
  (globalThis.__evaluated[${JSON.stringify(label)}] || 0) + 1;
export default class Provider {
  constructor() {
    globalThis.__constructed[${JSON.stringify(label)}] =
      (globalThis.__constructed[${JSON.stringify(label)}] || 0) + 1;
  }
  initRequest() {}
  supplyDataForRequest(request) {
    request.frontendData[${JSON.stringify(label)}] = 'supplied';
  }
  ping() { return 'pong from ${label}'; }
}
`;

function makeServer(): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.genericProviders = new Map();
  server.shapeProviders = new Map();
  server.providerIndexing = new Map();
  server.linkedPackageDirs = new Map();
  server.warnedDuplicateInstalls = new Set();
  server.package = JSON.parse(
    fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8')
  );
  server.config = { server: {} };
  return server;
}

let warnSpy: any;
let errorSpy: any;
let logSpy: any;
const text = (spy: any) =>
  spy.mock.calls.map((c: any[]) => c.map(String).join(' ')).join('\n');

beforeEach(() => {
  originalCwd = process.cwd();
  appDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'linked-nested-providers-'))
  );
  g.__constructed = {};
  g.__evaluated = {};
  // The app's own compiled backend, so loading it is quiet.
  writeFile('lib/backend.js', 'export {};\n');
  process.chdir(appDir);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
  process.chdir(originalCwd);
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe('nested linked packages', () => {
  it('(a) a nested package without a backend boots quietly', async () => {
    // rdfs-style: `./*` exports, so `./backend` maps to a file that is not there.
    writeApp({ '@_linked/fixture-owl': '1.0.0' });
    install('@_linked/fixture-owl', { deps: { '@_linked/fixture-rdfs': '1.1.2' } });
    install('@_linked/fixture-rdfs', { under: '@_linked/fixture-owl', version: '1.1.2' });

    const server = makeServer();
    await server.initBackendProviders();

    expect(server.genericProviders.get('@_linked/fixture-rdfs')).toBeNull();
    expect(text(warnSpy)).toBe('');
    expect(text(errorSpy)).toBe('');
  });

  it('(b) a nested package with a backend loads at boot, hooks requests and answers /call', async () => {
    writeApp({ '@_linked/fixture-owl': '1.0.0' });
    install('@_linked/fixture-owl', { deps: { '@_linked/fixture-rdfs': '1.0.0' } });
    install('@_linked/fixture-rdfs', {
      under: '@_linked/fixture-owl',
      backend: providerSource('rdfs'),
    });

    const server = makeServer();
    await server.initBackendProviders();
    expect(g.__constructed.rdfs).toBe(1);

    const request: any = { frontendData: {} };
    const { requestObject } = await server.getRequestData(request, {});
    expect(JSON.parse(requestObject)).toEqual({ rdfs: 'supplied' });

    const result = await server.callBackendMethod(
      '@_linked/fixture-rdfs',
      'ping',
      [],
      {},
      {}
    );
    expect(result).toBe('pong from rdfs');
    expect(g.__constructed.rdfs).toBe(1);
    expect(g.__evaluated.rdfs).toBe(1);
    expect(text(errorSpy)).toBe('');
  });

  it('(c) installed twice: loads only the copy the app resolves, and says so', async () => {
    writeApp({
      '@_linked/fixture-owl': '1.0.0',
      '@_linked/fixture-dup': '1.0.0',
    });
    // The nested copy is reached FIRST (owl is visited before the root dep).
    install('@_linked/fixture-owl', { deps: { '@_linked/fixture-dup': '2.0.0' } });
    const nested = install('@_linked/fixture-dup', {
      under: '@_linked/fixture-owl',
      version: '2.0.0',
      backend: providerSource('dup-2.0.0'),
    });
    const root = install('@_linked/fixture-dup', {
      version: '1.0.0',
      backend: providerSource('dup-1.0.0'),
    });

    const server = makeServer();
    await server.initBackendProviders();

    expect(g.__constructed).toEqual({ 'dup-1.0.0': 1 });
    expect(g.__evaluated).toEqual({ 'dup-1.0.0': 1 });
    const warned = text(warnSpy);
    expect(warned).toContain(
      `[linked] @_linked/fixture-dup is installed 2 times (2.0.0 at ${nested}, 1.0.0 at ${root}); loaded ${root}. Run npm dedupe.`
    );
    // Once, not once per lookup.
    expect(warned.split('is installed 2 times').length - 1).toBe(1);
  });

  it('(d) exports without ./backend and no pattern: quiet, nothing imported', async () => {
    writeApp({ '@_linked/fixture-closed': '1.0.0' });
    install('@_linked/fixture-closed', {
      exports: { '.': './lib/esm/index.js' },
      // A backend file exists, but the package does not export it.
      backend: providerSource('closed'),
    });

    const server = makeServer();
    await server.initBackendProviders();

    expect(g.__evaluated).toEqual({});
    expect(text(warnSpy)).toBe('');
    expect(text(errorSpy)).toBe('');
  });

  it('(e) a backend that throws on load is a loud error naming the package; boot continues', async () => {
    writeApp({ '@_linked/fixture-ok': '1.0.0' });
    install('@_linked/fixture-ok', {
      deps: { '@_linked/fixture-throws': '1.0.0' },
      backend: providerSource('ok'),
    });
    const throwing = install('@_linked/fixture-throws', {
      under: '@_linked/fixture-ok',
      backend: `throw new Error('boom at load');\nexport default class P {}\n`,
    });

    const server = makeServer();
    await server.initBackendProviders();

    expect(g.__constructed).toEqual({ ok: 1 });
    const logged = text(errorSpy);
    expect(logged).toContain('[linked] @_linked/fixture-throws');
    expect(logged).toContain(path.join(throwing, 'lib/esm/backend.js'));
    expect(logged).toContain('boom at load');
  });

  it("the server's load and the app's own bare import share one module instance", async () => {
    writeApp({ '@_linked/fixture-shared': '1.0.0' });
    install('@_linked/fixture-shared', { backend: providerSource('shared') });
    // An app module importing the backend by its bare name, the way app code would.
    writeFile(
      'app-entry.js',
      `import Provider from '@_linked/fixture-shared/backend';\nexport { Provider };\n`
    );

    const server = makeServer();
    await server.initBackendProviders();
    const app: any = await import(pathToFileURL(path.join(appDir, 'app-entry.js')).href);

    expect(g.__evaluated.shared).toBe(1);
    expect(server.genericProviders.get('@_linked/fixture-shared')).toBeInstanceOf(
      app.Provider
    );
  });
});
