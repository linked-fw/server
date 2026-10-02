import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import { FatalStartupError, isFatalError } from '../utils/fatalError.js';

// A provider that refuses to let the app start — @_linked/auth without its
// secrets in production — throws an error with own `fatal: true`. Boot must
// not swallow it the way it swallows an ordinary provider bug: start() rejects
// and the process is made to exit.

let appDir: string;
let originalCwd: string;
let errorSpy: any;
const g = globalThis as any;

// server-utils' Server reads SITE_ROOT when its module is evaluated, and a
// LinkedServer constructor registers itself there — so set it before loading.
const siteRootBefore = process.env.SITE_ROOT;
process.env.SITE_ROOT ??= 'http://localhost:4999';
const { LinkedServer } = await import('../shapes/LinkedServer.js');

function writeFile(rel: string, contents: string) {
  const file = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function installPackage(name: string, backend: string) {
  const root = `node_modules/${name}`;
  writeFile(
    `${root}/package.json`,
    JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      linkedPackage: true,
      main: 'lib/esm/index.js',
      exports: {
        '.': { import: './lib/esm/index.js' },
        './*': { import: './lib/esm/*.js' },
      },
    })
  );
  writeFile(`${root}/lib/esm/index.js`, 'export {};\n');
  writeFile(`${root}/lib/esm/backend.js`, backend);
}

const FATAL = `Object.assign(new Error('JWT_SECRET is not set'), { fatal: true })`;

const healthy = `
globalThis.__hooks = globalThis.__hooks || [];
export default class Provider {
  setupBeforeControllers() { globalThis.__hooks.push('healthy:before'); }
}
`;

const providers = {
  fatalInSetup: `
export default class Provider {
  setupBeforeControllers() { throw ${FATAL}; }
}
`,
  fatalInAsyncSetup: `
export default class Provider {
  async setupAfterControllers() { throw ${FATAL}; }
}
`,
  fatalInConstructor: `
export default class Provider {
  constructor() { throw ${FATAL}; }
}
`,
  fatalAtModuleLoad: `
throw ${FATAL};
export default class Provider {}
`,
  nonFatalInSetup: `
export default class Provider {
  setupBeforeControllers() { throw new Error('ordinary bug'); }
}
`,
  fatalPerRequest: `
export default class Provider {
  initRequest() { throw ${FATAL}; }
  supplyDataForRequest() { throw ${FATAL}; }
}
`,
};

/** An app depending on `broken`, indexed before `healthy-linked`. */
function setUpApp(brokenBackend: string) {
  writeFile(
    'package.json',
    JSON.stringify({
      name: 'fixture-app',
      type: 'module',
      dependencies: { '@_linked/fixture-broken': '1.0.0', 'healthy-linked': '1.0.0' },
    })
  );
  installPackage('@_linked/fixture-broken', brokenBackend);
  installPackage('healthy-linked', healthy);
  writeFile('lib/backend.js', 'export {};\n');
}

/** A real LinkedServer whose fatal exit is recorded instead of performed. */
function makeServer(): any {
  const server: any = new LinkedServer({ server: { apiOnly: true } } as any);
  server.exitedFatally = [];
  server.exitAfterFatalStartupError = (err: unknown) =>
    server.exitedFatally.push(err);
  return server;
}

const logged = () =>
  errorSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n');

const servers: any[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

afterAll(() => {
  if (siteRootBefore === undefined) delete process.env.SITE_ROOT;
});

beforeEach(() => {
  originalCwd = process.cwd();
  appDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'linked-fatal-providers-'))
  );
  g.__hooks = [];
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  process.chdir(appDir);
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => s.httpServer?.close(resolve) ?? resolve(null));
  }
  errorSpy.mockRestore();
  process.chdir(originalCwd);
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe('a fatal provider error at boot', () => {
  it.each([
    ['setupBeforeControllers', 'fatalInSetup', 'setupBeforeControllers'],
    ['an async setupAfterControllers', 'fatalInAsyncSetup', 'setupAfterControllers'],
    ['the provider constructor', 'fatalInConstructor', 'default constructor'],
    ['the backend module load', 'fatalAtModuleLoad', 'backend '],
  ])('thrown in %s rejects start() and exits', async (_, fixture, hook) => {
    setUpApp((providers as any)[fixture]);
    const server = makeServer();
    servers.push(server);

    const started = server.start();
    await expect(started).rejects.toThrow('JWT_SECRET is not set');
    const err = await started.catch((e: unknown) => e);

    expect(isFatalError(err)).toBe(true);
    expect(server.exitedFatally).toEqual([err]);
    // Never got as far as listening.
    expect(server.httpServer).toBeUndefined();
    expect(logged()).toContain(`[linked] @_linked/fixture-broken ${hook}`);
    expect(logged()).toContain(
      ': fatal error, refusing to start: JWT_SECRET is not set'
    );
    expect(server.booting).toBe(false);
  });

  it('rejects initOnly() too', async () => {
    setUpApp(providers.fatalInConstructor);
    const server = makeServer();
    await expect(server.initOnly()).rejects.toThrow('JWT_SECRET is not set');
    expect(server.exitedFatally).toHaveLength(1);
  });
});

describe('a non-fatal provider error at boot', () => {
  it('is still isolated: start() resolves and the other providers run', async () => {
    setUpApp(providers.nonFatalInSetup);
    const server = makeServer();
    servers.push(server);
    // start() reads PORT with `|| 4000`, so 0 would mean 4000: use a free port.
    process.env.PORT = String(await freePort());
    try {
      await expect(server.start()).resolves.toBe(server);
    } finally {
      delete process.env.PORT;
    }
    expect(g.__hooks).toEqual(['healthy:before']);
    expect(server.exitedFatally).toEqual([]);
    expect(logged()).toContain(
      '[linked] @_linked/fixture-broken setupBeforeControllers failed: ordinary bug'
    );
  });

  it('`fatal` must be an own property set to true', () => {
    expect(isFatalError(new FatalStartupError('x'))).toBe(true);
    expect(Object.keys(new FatalStartupError('x'))).toContain('fatal');
    expect(isFatalError(Object.assign(new Error('x'), { fatal: true }))).toBe(true);
    expect(isFatalError(Object.assign(new Error('x'), { fatal: 'yes' }))).toBe(false);
    expect(isFatalError(Object.create({ fatal: true }))).toBe(false);
    expect(isFatalError(new Error('x'))).toBe(false);
    expect(isFatalError(null)).toBe(false);
  });
});

describe('a fatal provider error after boot', () => {
  it('in a per-request hook is logged and contained: the request is served', async () => {
    setUpApp(providers.fatalPerRequest);
    const server = makeServer();
    await server.initOnly();

    const request: any = { frontendData: {} };
    await server.initRequest(request, {});
    const { requestObject } = await server.getRequestData(request, {});

    expect(JSON.parse(requestObject)).toEqual({});
    expect(server.exitedFatally).toEqual([]);
    expect(logged()).toContain(
      '[linked] @_linked/fixture-broken initRequest: fatal error after start, server keeps running: JWT_SECRET is not set'
    );
  });

  it('in a backend loaded lazily by a later /call is logged and contained', async () => {
    setUpApp(healthy);
    installPackage('late-linked', providers.fatalInConstructor);
    const server = makeServer();
    await server.initOnly();

    await expect(
      server.ensurePackageBackendProviders('late-linked')
    ).resolves.toBeUndefined();
    expect(server.genericProviders.get('late-linked')).toBeFalsy();
    expect(logged()).toContain(
      '[linked] late-linked default constructor: fatal error after start, server keeps running'
    );
  });
});

describe('the default exit after a fatal startup error', () => {
  it('sets exit code 1 now, and exits 1 shortly after on an unref’d timer', () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const previous = process.exitCode;
    try {
      const server: any = Object.create(LinkedServer.prototype);
      server.exitAfterFatalStartupError(new FatalStartupError('x'));
      expect(process.exitCode).toBe(1);
      expect(exit).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      process.exitCode = previous;
      exit.mockRestore();
      jest.useRealTimers();
    }
  });
});
