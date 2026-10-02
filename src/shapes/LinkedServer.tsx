'use strict';
import { timingSafeEqual } from 'crypto';
import events from 'events';
import express, { Express as ExpressServer } from 'express';
import fetchCookie from 'fetch-cookie';
import * as fsNative from 'fs';
import * as fs from 'fs/promises';
import { Server as HttpServer } from 'http';
// Plan-011: imports from @_linked/cli now go through ./lifecycle (a
// dynamic-import-free file) so Vite's SSR module graph doesn't pull
// in the legacy webpack flow and emit dozens of unanalyzable-import
// warnings on every boot.
import { getLincdPackages } from '@_linked/cli/lifecycle';
import { getPackageJSON } from '@_linked/cli/utils';
import type { LinkedConfig } from '@_linked/cli/interfaces';
import { AppContextProvider } from '@_linked/server-utils/components/AppContext';
import { BackendProvider } from '@_linked/server-utils/utils/BackendProvider';
import { JSONParser } from '@_linked/server-utils/utils/JSONParser';
import { JSONWriter } from '@_linked/server-utils/utils/JSONWriter';
import { Server } from '@_linked/server-utils/utils/Server';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { ShapeProvider } from '@_linked/server-utils/utils/ShapeProvider';
import { Shape } from '@_linked/core/shapes/Shape';
import { LinkedErrorLogging } from '@_linked/core/utils/LinkedErrorLogging';
import {
  FileStorePurposes,
  LinkedFileStorage,
} from '@_linked/core/utils/LinkedFileStorage';
import type { IFileStore } from '@_linked/core/interfaces/IFileStore';
import { getResizedImagesStore } from '../utils/resizedImagesPurpose.js';
import { paint } from '../utils/paint.js';
import { createJsonBodyParser } from '../utils/jsonBodyParser.js';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { autoLoadOntologyData } from '@_linked/core/utils/Package';
import {
  getShapeClass,
  getSuperShapesClasses,
} from '@_linked/core/utils/ShapeClass';
import path from 'path';
import {pathToFileURL} from 'node:url';
import { isFatalError } from '../utils/fatalError.js';
import {
  discoverLinkedDependencies,
  isBundledBySsr,
  NODE_IMPORT_CONDITIONS,
  readInstalledPackage,
  resolveBackendEntry,
  ssrNoExternalOf,
} from '../utils/linkedDependencies.js';

/**
 * `instanceof ShapeProvider`, tolerating a second copy of server-utils.
 *
 * A registry-installed package's backend is loaded by Node (see
 * isBundledBySsr), so in a dev runner that BUNDLES server-utils — the
 * standalone case — its providers extend Node's copy of ShapeProvider, not the
 * one this module imported. Fall back to the class name along the prototype
 * chain. Production has one loader and one copy, so instanceof decides there.
 */
function isShapeProvider(provider: any): boolean {
  if (provider instanceof ShapeProvider) return true;
  for (
    let proto = provider ? Object.getPrototypeOf(provider) : null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    if (proto.constructor?.name === 'ShapeProvider') return true;
  }
  return false;
}

/**
 * Call one provider's hook and contain its failure: a synchronous throw or a
 * rejection is logged, naming the package and the hook, and swallowed. Used
 * for hooks that run for every provider (boot lifecycle hooks and per-request
 * hooks), where one provider's bug must not take down boot or every request
 * without saying which provider it was.
 *
 * The exception is a fatal error (see utils/fatalError): with `atBoot` it is
 * logged and re-thrown, so the server refuses to start. Without it — the
 * server is already serving — it is logged as fatal and contained like any
 * other error: one provider must not take a running server down.
 */
async function runProviderHook(
  pkg: string,
  hook: string,
  call: () => any,
  atBoot = false
): Promise<void> {
  try {
    await call();
  } catch (err: any) {
    if (isFatalError(err)) {
      logFatalError(pkg, hook, err, atBoot);
      if (atBoot) throw err;
      return;
    }
    console.error(
      paint('red', `[linked] ${pkg} ${hook} failed: ${err?.message ?? err}`),
      err?.stack ? `\n${err.stack}` : ''
    );
  }
}

/** Log a fatal error once, at the point it was thrown (see runProviderHook). */
function logFatalError(pkg: string, hook: string, err: any, atBoot: boolean) {
  if (loggedFatalErrors.has(err)) return;
  loggedFatalErrors.add(err);
  console.error(
    paint(
      'red',
      atBoot
        ? `[linked] ${pkg} ${hook}: fatal error, refusing to start: ${err?.message ?? err}`
        : `[linked] ${pkg} ${hook}: fatal error after start, server keeps running: ${err?.message ?? err}`
    ),
    err?.stack ? `\n${err.stack}` : ''
  );
}
const loggedFatalErrors = new WeakSet<object>();

import process from 'process';
import * as React from 'react';
import { renderToPipeableStream, renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { rimraf } from 'rimraf';
import sharp from 'sharp';
import {
  findStoredKey,
  resolveResizeSource,
} from '../utils/resizeSource.js';
import { Transform } from 'stream';
import { CookieJar } from 'tough-cookie';
import { lincdServer } from '../ontologies/lincd-server.js';
import { linkedShape } from '../package.js';
import {
  resolveStaticAccessURL,
  staticAssetURL,
} from '../utils/releaseManifest.js';
import {
  resolveBootstrapEntry,
  resolveViteMainEntry,
  resolveViteServingMode,
} from '../utils/bootstrapEntry.js';
import { resolveRouteAssets } from '../utils/routeAssets.js';
import {
  resolveRouteComponent,
  ssrCssInlineUrls,
  ssrCssScope,
} from '../utils/ssrCss.js';
import { indexShapesIntoMemory } from '../utils/Shapes.js';
import { materializeShapes } from '../utils/syncShapes.js';
import {
  installSpaFallback,
  repinSpaFallback,
} from '../utils/spaFallback.js';
import { LincdAPI } from './LincdAPI.js';
import type { RoutesConfig, RouteConfig } from '../types/RouteConfig.js';

//prevent errors in node.js when (s)css files are imported in js
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

declare var globalThis: any;
// Install a global fetch that persists cookies across redirects using a CookieJar.
// This ensures server-side requests behave more like browsers when handling Set-Cookie + redirects.
const __lincdCookieJar = new CookieJar();
// Wrap native fetch with fetch-cookie so it reads/writes cookies in the jar.
const __lincdFetchWithCookies = fetchCookie(fetch, __lincdCookieJar);

// Expose (optionally) for debugging/tests; not required by app logic.
(globalThis as any).__lincdCookieJar = __lincdCookieJar;

// Set the global fetch used throughout the server code path
(globalThis as any).fetch = __lincdFetchWithCookies;

process.on('uncaughtException', (err) => {
  console.warn(paint('red', 'Asynchronous error caught.'));
  console.error(err);

  // error logging
  LinkedErrorLogging.log(err);
});
process.on('unhandledRejection', (err) => {
  console.warn(paint('red', 'Unhandled rejection caught.'));
  console.error(err);

  // error logging
  LinkedErrorLogging.log(err as Error);
});

process.on('warning', (e) => console.warn(e.stack));

//allow more listeners for when we have many concurrent users
events.EventEmitter.prototype.setMaxListeners(500);

// const jsdom = require("jsdom");
// const { JSDOM } = jsdom;
// const { document } = (new JSDOM(`...`)).window;
//
// global['document'] = document;
global['reactStaticRenderer'] = renderToStaticMarkup;

autoLoadOntologyData(true);

// Named explicitly: tsc emits `let X = class X`, and any later esbuild pass over that JS (Vite's
// SSR `define` replacement runs one on every file mentioning a defined `process.env.*`) renames
// the inner binding to `X2`, which would otherwise become this shape's IRI.
@linkedShape({name: 'LinkedServer'})
export class LinkedServer extends Shape {
  /**
   * indicates that instances of this shape need to have this rdf.type
   */
  static targetClass = lincdServer.LincdServer;
  private config: LinkedConfig;
  private cachedPaths: Map<string, string> = new Map();
  private assets: { [key: string]: string } & {
    manifest?: Record<string, string>;
  };
  /**
   * Whether pages are served by the live Vite dev server rather than a
   * `vite build` on disk. Decided once in `start()` — see
   * utils/bootstrapEntry `resolveViteServingMode`.
   */
  private viteDevServer = false;
  /**
   * Base URL every asset this build produced is served from — resolved once in
   * `start()` and kept so per-request route chunks land on the same base as
   * the entry tags. Empty means origin-relative (development, and any app
   * serving its own bundles).
   */
  private staticAccessURL: string = '';
  /**
   * Whether `assets['main.js']` came from a Vite build. Vite always emits the
   * entry as an ES module, so it has to be bootstrapped with
   * `bootstrapModules`; a legacy webpack bundle is a classic script and must
   * keep `bootstrapScripts`.
   */
  private mainEntryIsModule = false;
  protected server: ExpressServer;
  protected httpServer: HttpServer;
  private package: any;
  private cacheWebpack: boolean;
  private cssMode = 'scss-modules';
  private analyse: boolean = false;
  private shapeProviders: Map<string, ShapeProvider[]> = new Map();
  private genericProviders: Map<string, BackendProvider> = new Map();
  // One indexing per package: boot and the lazy /call path share it, so two
  // concurrent first calls (or a call racing boot) never construct a
  // package's providers twice.
  private providerIndexing: Map<string, Promise<void>> = new Map();
  /**
   * Package name → realpath of the installed copy whose backend is loaded,
   * as discovery found it. A package's backend is resolved from THIS
   * directory, never by its bare name from @_linked/server's own location:
   * Node would never look inside another package's nested node_modules, so a
   * linked package installed only there (owl/node_modules/@_linked/rdfs)
   * could not be loaded at all.
   */
  private linkedPackageDirs: Map<string, string> = new Map();
  private warnedDuplicateInstalls: Set<string> = new Set();
  //from resizedFileName to full resized path (CDN or similar)
  private resizePathsMap: Map<string, string> = new Map();
  private api: LincdAPI;
  /**
   * True while start() / initOnly() runs. A fatal provider error (see
   * utils/fatalError) thrown while booting stops the boot; after it, the same
   * error is logged and contained.
   */
  protected booting = false;

  /**
   * yarn linked start sends the contents of linked.config.js as an object to this constructor
   * @param n
   */
  constructor(config?: LinkedConfig | string | { id?: string }) {
    super(
      typeof config === 'string' || (config && 'id' in config)
        ? config
        : undefined
    );
    if (config && typeof config !== 'string' && !('id' in config)) {
      // The absence of `id` is the runtime discriminator for a LinkedConfig;
      // the widened `{id?: string}` member of the union keeps TS from narrowing
      // to it on that check alone.
      this.config = config as LinkedConfig;
    }

    this.api = new LincdAPI({ id: process.env.SITE_ROOT + '/api' });

    //Ensure the Server utility (for Server.call()) directly accesses
    // this server on the backend instead of going through a network call
    Server.setLocalServer(this);
  }

  /*async getLincdDependencies(): Promise<string[]> {
		let lincdDependencies = [];
		let dependencies = this.package.dependencies;

		await Promise.all(
			Object.keys(dependencies).map((dependencyPkgName) => {
				let modulePackageJson = getModulePackageJSON(dependencyPkgName);
				if (modulePackageJson['lincd']) {
					lincdDependencies.push(modulePackageJson.name);
				}
				//   //TODO: also iteratively look into dependencies of this dependency

				// let packagePath;
				// try {
				//   packagePath = require.resolve(`${dependencyPkgName}`);
				// } catch (err) {
				//   console.warn('Could not find package ' + dependencyPkgName+'. Error: '+err.toString());
				//   return;
				// }
				// packagePath = path.dirname(packagePath) + '/package.json'
				// return fs
				//   .readFile(packagePath, 'utf-8')
				//   .then((res) => {
				//     let pkg = JSON.parse(res);
				//     if (pkg['lincd']) {
				//       lincdDependencies.push(pkg.name);
				//     }
					//   //TODO: also iteratively look into dependencies of this dependency
					// })
					// .catch((err) => {
					//   console.log('Could not read package.json file: '+err);
					// });
			}),
		);
		return lincdDependencies;
	}*/
  get app() {
    return this.server;
  }

  initPackage() {
    this.package = JSON.parse(
      fsNative.readFileSync(
        path.resolve(process.cwd(), 'package.json'),
        'utf-8'
      )
    );
  }
  async initOnly() {
    return this.bootOrRefuse(() => this.initOnlyBoot());
  }

  private async initOnlyBoot() {
    await this.initOntologies();
    await this.initStores();

    this.initPackage();

    this.server = express();

    await this.initBackendProviders();

    await indexShapesIntoMemory();
    await this.materializeShapesIntoStore();
    return this;
  }

  /**
   * Materialize this server's registered shapes into the RDF store as SHACL
   * (core `syncShapes` → pure `sh:NodeShape` + property shapes), so a running
   * app's app-data holds the shapes its instances validate/query against
   * (plan-010 T1e.2). Whatever shapes the app package registers (published
   * re-exports + generated) get written on boot (and re-run on shape-file HMR).
   *
   * Additive only: store shapes this process did not register are left alone
   * unless the operator sets `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true` — see
   * `bootOrphanScope` in utils/syncShapes for why.
   *
   * Gated to servers whose DEFAULT dataset is a **concrete** materializable store
   * (detected via `rawQuery`) — i.e. an app pointing at its app-data FusekiStore.
   * CN's default is the context-routing `AppDataRouter` (no `rawQuery`), so CN is
   * skipped here — it materializes its own pinned native shapes in its storage
   * config.
   */
  private async materializeShapesIntoStore(): Promise<void> {
    // Opt-out via `linked.config` `syncShapesOnBoot` (default true); env
    // LINKED_SYNC_SHAPES_ON_BOOT overrides for deployment. CN sets
    // `syncShapesOnBoot: false` in its own linked.config — its default dataset is
    // a context-router that can't materialize context-free, and it syncs its own
    // pinned shapes separately (linked.backend.storage.js).
    const configFlag = (this.config as any)?.syncShapesOnBoot;
    const envFlag = process.env.LINKED_SYNC_SHAPES_ON_BOOT;
    if (configFlag === false || envFlag === 'false') {
      return;
    }
    const appData = LinkedStorage.getDefaultDataset();
    if (!appData) return;
    try {
      const {syncShapes} = await import('@_linked/core');
      // Explicit target: materialize EVERY registered shape into the app's own
      // data store regardless of per-shape routing/pins.
      await materializeShapes(appData, syncShapes as any);
    } catch (err) {
      console.warn('[LinkedServer] shape materialization failed (non-fatal):', err);
    }
  }

  // async serveData(req,res) {
  //   let nodeURI = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  //
  //   let store = LinkedStorage.getDatasets().find(store => {
  //     return nodeURI.includes(store.namedNode.uri)
  //   })
  // }

  /**
   * Boot the server and listen. Rejects — and makes the process exit non-zero —
   * when a provider throws a fatal error while booting (see utils/fatalError).
   */
  async start() {
    return this.bootOrRefuse(() => this.startBoot());
  }

  /**
   * Run a boot with `booting` set. A fatal provider error rejects it and hands
   * the error to exitAfterFatalStartupError; any other boot error rejects as it
   * always did.
   */
  private async bootOrRefuse<T>(boot: () => Promise<T>): Promise<T> {
    this.booting = true;
    try {
      return await boot();
    } catch (err) {
      if (isFatalError(err)) this.exitAfterFatalStartupError(err);
      throw err;
    } finally {
      this.booting = false;
    }
  }

  /**
   * Make sure a server that refused to start does not stay up as a process.
   *
   * start() rejects either way, so the caller can report the error. But a
   * rejected start() does not end the process on its own: the CLI's `linked
   * start` turns an unhandled rejection into a log line, and the Vite dev
   * server, a store connection or a provider's timer keeps the event loop
   * alive. So the exit code is set now — a process with nothing left running
   * exits 1 — and, as a backstop, the process is exited after a moment, on an
   * unref'd timer that never itself keeps the process alive.
   *
   * Override to embed the server somewhere that must not exit (tests).
   */
  protected exitAfterFatalStartupError(_err: unknown) {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1000).unref();
  }

  private async startBoot() {
    this.initPackage();
    // Static assets should come from the static store URL (versioned path),
    // not the upload store URL. An explicit STATIC_ACCESS_URL still wins;
    // otherwise the release manifest `linked build-app` wrote next to the
    // bundle says which published release this build is, so a deployment no
    // longer has to repeat that URL by hand. See utils/releaseManifest.
    // In development we deliberately use a relative path so bundle URLs work
    // regardless of which PORT the dev server bound to (browsers resolve
    // relative URLs against window.location.origin). Hardcoding SITE_ROOT
    // baked :4000 into every SSR'd HTML page.
    const isDevAssets = process.env.NODE_ENV === 'development';
    const staticAccessURL = resolveStaticAccessURL({
      isDevAssets,
      appRoot: process.cwd(),
      fileStoreAccessURL: LinkedFileStorage.accessURL,
    });
    this.staticAccessURL = staticAccessURL;
    const staticAsset = (assetPath: string) =>
      staticAssetURL(staticAccessURL, assetPath);

    // Bundle/manifest read (plan-011: Vite is the only supported build).
    // Vite manifest lives at public/bundles/.vite/manifest.json.
    this.assets = {
      'main.js':
        staticAsset('/bundles/main.bundle.js') + '?v=' + this.package.version,
      'main.css': staticAsset('/bundles/main.css'),
    };
    // Dev or built, decided once and reused by the render path — see
    // utils/bootstrapEntry. In development the build manifest is not read:
    // one left on disk by an earlier `vite build` would otherwise swap in
    // stale built CSS while Vite serves the live styles.
    const servingMode = resolveViteServingMode({
      viteConfig: (this.config.server as any)?.vite,
      nodeEnv: process.env.NODE_ENV,
      readManifest: () => {
        try {
          const viteManifestPath = path.resolve(
            process.cwd(),
            'public/bundles/.vite/manifest.json'
          );
          if (!fsNative.existsSync(viteManifestPath)) return null;
          return JSON.parse(fsNative.readFileSync(viteManifestPath, 'utf-8'));
        } catch (err) {
          console.warn('Could not load bundle manifest:', err);
          return null;
        }
      },
    });
    this.viteDevServer = servingMode.viteDevServer;
    if (servingMode.manifest) {
      const viteManifest = servingMode.manifest as Record<string, any>;
      this.assets.manifest = viteManifest;
      // Resolve main entry per Vite manifest shape:
      //   { "src/index.tsx": { file: "assets/main-<hash>.js", css: [...] } }
      const mainEntry = resolveViteMainEntry(viteManifest);
      if (mainEntry?.file) {
        this.assets['main.js'] = staticAsset(`/bundles/${mainEntry.file}`);
        this.mainEntryIsModule = true;
      }
      if (mainEntry?.css?.[0]) {
        this.assets['main.css'] = staticAsset(`/bundles/${mainEntry.css[0]}`);
      }
    }
    // Vite dev marker: the HTML renderer skips pre-built CSS/JS link tags,
    // because Vite handles asset injection itself.
    if (this.viteDevServer) {
      this.assets['__viteDev'] = '1';
    }

    const isProduction = process.env.NODE_ENV === 'production';
    if (!isProduction && this.config.cssMode === 'tailwind') {
      this.assets['tailwind-cdn'] = 'https://cdn.tailwindcss.com';
    }

    //for multicore we use PM2, and each instance needs to listen to port 0.
    // whilst the main thread will listen to env.PORT automatically
    // const PORT = this.config.multiCore ? 0 : process.env.PORT || 3000;
    // const publicPort = process.env.PORT || 3000;
    //update: back to original setup. multicore handles itself inside @semantu/multicore
    const PORT = parseInt(process.env.PORT) || 4000;
    this.server = express();

    const dirName = path.resolve(process.cwd(), 'frontend');

    await this.initOntologies();
    //TODO: when we do not keep all data in memory (and thus do not need to rely on in memory data for page requests), we can possibly remove await here, since all stores handle their own initialisation before executing commands
    await this.initStores();

    this.initGarbageCollection();
    // this.app.use((req, res, next) => {
    //   console.log('start request');
    //   next();
    // });
    // before controllers
    await this.initBackendProviders();

    await indexShapesIntoMemory();
    await this.materializeShapesIntoStore();

    //START OF EXPRESS ROUTES AND MIDDLEWARE

    //use cors
    // var corsOptions = {
    //   origin: ['http://localhost:4001', 'https://www.mynd.site'],
    //   optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
    // };
    //accept JSON bodies
    this.server.use(createJsonBodyParser());

    // this.server.use(cors(corsOptions));
    //
    // //compress server output with gzip,
    //UPDATE ive set level to 2 (low compression fast speed) because responses were taking too long (98% of server time was used by compress)
    // this.server.use(compress({level: 2}));

    await this.callGenericBackendProvidersMethod('setupBeforeControllers');

    // Vite middleware (plan 010): when the user app starts via Vite
    // (`linked start --vite`), the orchestrator passes the Vite handle
    // through config.server.viteMiddleware. We mount it and skip the
    // entire webpack-dev-middleware setup below.
    const viteMiddleware = (this.config.server as any)?.viteMiddleware;
    if (viteMiddleware) {
      this.server.use(viteMiddleware);
    }

    // Plan-011: legacy webpack-dev-middleware branch removed. Under Vite
    // (the only supported dev path now) `viteMiddleware` is set, which
    // previously forced `skipBuild = true` and made this whole block
    // dead. Removing it ends the static dependency on @_linked/cli/
    // config-webpack-app (full of dynamic imports Vite couldn't analyze)
    // and shrinks LinkedServer's import surface considerably.

    // //map URL routes to file paths
    const oneYear = 1000 * 60 * 60 * 24 * 365; // in milliseconds
    const oneMonth = 1000 * 60 * 60 * 24 * 30; // in milliseconds
    this.server.use(
      '/public',
      express.static('./public', {
        maxAge: oneYear, // Tell browser to cache for 1 year
        immutable: true, // Suggest that the content won't change
      })
    );

    this.server.use(
      '/uploads',
      express.static('./data/uploads', {
        maxAge: oneYear, // Tell browser to cache for 1 year
        immutable: true, // Suggest that the content won't change
      })
    );
    this.server.use('/', express.static('./public/root'));
    this.server.use(
      '/favicon.ico',
      express.static('./public/favicon.ico', {
        maxAge: oneMonth, // Tell browser to cache for 1 year
        immutable: true, // Suggest that the content won't change
      })
    );
    this.server.use('/.well-known', express.static('./public/.well-known'));

    // this.server.post('/data',this.handleErrorsJson(async (req,res) => this.serveData(req, res)));
    this.server.get('/resized/*', async (req, res) => {
      this.resizeImage(req, res);
    });

    // Scoped-package variants (@scope/pkg). Register BEFORE the unscoped
    // routes — Express `:pkg` won't consume slashes, so a call to
    // `/call/@_linked/auth/signinDev` would otherwise fall through to the
    // 3-segment `:pkg/:shape/:method` route and be misinterpreted as a
    // shape-method call (pkg=`@_linked`, shape=`auth`). These handlers
    // recognise the `@scope/pkg` prefix and rebuild the full package name
    // before dispatching to the same handler used for unscoped packages.
    this.server.post(
      '/call/@:scope/:pkg/:method',
      this.handleErrorsJson(async (req, res) => {
        req.params.pkg = `@${req.params.scope}/${req.params.pkg}`;
        return this.processBackendMethodCall(req, res);
      })
    );
    this.server.post(
      '/call/@:scope/:pkg/:shape/:method',
      this.handleErrorsJson(async (req, res) => {
        req.params.pkg = `@${req.params.scope}/${req.params.pkg}`;
        return this.processShapeMethodCall(req, res);
      })
    );
    this.server.post(
      '/call/:pkg/:method',
      this.handleErrorsJson(async (req, res) =>
        this.processBackendMethodCall(req, res)
      )
    );
    this.server.post(
      '/call/:pkg/:shape/:method',
      this.handleErrorsJson(async (req, res) =>
        this.processShapeMethodCall(req, res)
      )
    );
    this.server.post(
      '/api/:method/:action?',
      this.handleErrorsJson(async (req, res) =>
        this.processAPICall(req, res, 'post')
      )
    );
    this.server.get(
      '/api/:method/:action?',
      this.handleErrorsJson(async (req, res) =>
        this.processAPICall(req, res, 'get')
      )
    );
    // this.server.post(
    //   '/api/query/:method',
    //   this.handleErrorsJson(async (req, res) => this.processQuery(req, res)),
    // );

    // now that all the middleware is defined, we initialise the providers, before we define a catch-all route
    // before catch all
    // await this.initBackendProviders();
    await this.callGenericBackendProvidersMethod(
      'setupBeforeCatchAllControllers'
    );

    // HEAD catch-all for maintenance/health check (client fetches SITE_ROOT with method: HEAD)
    this.server.head('__health', (_req, res) => {
      res.sendStatus(200);
    });

    // CN control channel (plan-010 T1b.3). Present only when CN spawned this
    // process with a shared secret (CN_APP_ADMIN_SECRET); a standalone app run
    // without the secret leaves the channel closed (404). Auth is the
    // x-cn-admin-secret header matching that env value.
    const adminSecret = process.env.CN_APP_ADMIN_SECRET;
    // Constant-time compare so the secret can't be recovered by timing the 401
    // response. timingSafeEqual requires equal-length buffers, so guard length.
    const secretMatches = (provided: string | undefined): boolean => {
      if (!adminSecret || !provided) return false;
      const a = Buffer.from(provided);
      const b = Buffer.from(adminSecret);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    const requireAdmin = (req: express.Request, res: express.Response): boolean => {
      if (!adminSecret) {
        res.sendStatus(404); // no control channel in this mode
        return false;
      }
      if (!secretMatches(req.get('x-cn-admin-secret'))) {
        res.sendStatus(401);
        return false;
      }
      return true;
    };
    this.server.get('/admin/health', (req, res) => {
      if (!requireAdmin(req, res)) return;
      res.status(200).json({ status: 'ok' });
    });
    this.server.post('/admin/restart', (req, res) => {
      if (!requireAdmin(req, res)) return;
      res.sendStatus(202);
      // CN's provisioner respawns on exit (see ChildProcessProvisioner).
      setTimeout(() => process.exit(0), 50);
    });

    // after controller
    await this.callGenericBackendProvidersMethod('setupAfterControllers');

    // The SPA catch-all goes on LAST. `setupAfterControllers` is a documented
    // hook for providers to register their own routes, so installing the
    // catch-all before it would shadow every GET route registered there —
    // answering them with the client shell at status 200.
    // An API-only backend (`linked start --api-only`) has no app to render:
    // without the catch-all, page requests get express's plain 404.
    if (!(this.config.server as any)?.apiOnly) {
      this.installSpaFallback();
    }

    //remove http(s):// and remove port :[port]
    const HOST = process.env.SITE_ROOT.replace(/https?:\/\//, '').replace(
      /:\d+$/,
      ''
    );

    //backlog of 1024 means maximum of 1024 connections in the queue (higher than default)
    this.httpServer = this.server.listen({ port: PORT, backlog: 1024 }, () => {
      console.log(`Up and running at http://localhost:${PORT}`);
      // open(`http://localhost:${PORT}`)
    });
    // Ensure all inactive connections are terminated by the ALB, by setting this a few seconds higher than the ALB idle timeout
    this.httpServer.keepAliveTimeout = 60_000;
    // Ensure the headersTimeout is set higher than the keepAliveTimeout due to this nodejs regression bug: https://github.com/nodejs/node/issues/27363
    this.httpServer.headersTimeout = 61_000;

    this.httpServer.on('error', function (error) {
      if (error['syscall'] !== 'listen') {
        throw error;
      }
      const isPipe = (portOrPipe) => Number.isNaN(portOrPipe);
      const bind = isPipe(PORT) ? 'Pipe ' + PORT : 'Port ' + PORT;
      switch (error['code']) {
        case 'EACCES':
          console.error(bind + ' requires elevated privileges');
          process.exit(1);
        case 'EADDRINUSE':
          console.error(bind + ' is already in use');
          process.exit(1);
        default:
          throw error;
      }
    });
    return this;
  }

  async initOntologies() {}

  /**
   *
   * @returns
   * @todo Check if default file store is set, if not, set it
   */
  async initStores() {
    return Promise.all(
      LinkedStorage.getDatasets().map((store) => {
        return store.init ? store.init() : Promise.resolve();
      })
    );
  }

  /**
   * Run a lifecycle hook (setupBeforeControllers, setupBeforeCatchAllControllers,
   * setupAfterControllers) on every generic provider, in indexing order.
   *
   * Each provider is isolated: a hook that throws (or rejects) is logged with
   * the package and hook name and the next provider still runs, so one broken
   * provider does not abort boot. That provider's routes or middleware from
   * that hook may be missing, but the rest of the app starts.
   */
  async callGenericBackendProvidersMethod(method: string, ...args: any[]) {
    for (let [pkg, genericProvider] of this.genericProviders.entries()) {
      if (!genericProvider || typeof genericProvider[method] !== 'function') {
        continue;
      }
      await runProviderHook(
        pkg,
        method,
        () => genericProvider[method](...args),
        this.booting
      );
    }
  }

  /**
   * Removes temporary nodes from memory if they've been seen twice
   * Current interval is once per hour.
   * So after 2 hours temporary nodes are removed.
   */
  initGarbageCollection() {
    // let seenLastTime:NodeSet<NamedNode> = null;
    // setInterval(() => {
    //
    //   let tempNodes = new NodeSet<NamedNode>();
    //   NamedNode.getAllNamedNodes().forEach(n => {
    //     if(n.isTemporaryNode) {
    //       if(seenLastTime && seenLastTime.has(n))
    //       {
    //         n.remove();
    //       } else {
    //         tempNodes.add(n);
    //       }
    //     }
    //   })
    //   seenLastTime = tempNodes;
    // }, 1000 * 10); //every 10 sec
    // // }, 1000 * 60 * 60); //every hour
  }
  async initBackendProviders() {
    // Local workspace packages in this app's dependency tree. These are also
    // imported whole at boot (indexLincdPackage), not only their /backend.
    const allLocalPackages = getLincdPackages();
    const localPackageMap = new Map<
      string,
      { packageName: string; path: string }
    >(allLocalPackages.map((pkg) => [pkg.packageName, pkg]));
    const relevantPackages = this.filterPackagesByDependencyTree(
      localPackageMap,
      this.package
    );
    // Every linked package in the dependency tree, installed or local, each
    // after the linked packages it depends on. Registry installs and
    // localized checkouts are not workspace members, and used to be indexed
    // only lazily, on the first /call/<pkg>/... A provider can hook every
    // request (initRequest, supplyDataForRequest, setupBeforeControllers
    // routes), so those hooks stayed silent until some RPC to the package
    // happened — an installed @_linked/auth did not put the session into a
    // page's request data until then, and its setupBeforeControllers
    // middleware never registered at all.
    await this.indexLinkedDependencyProviders(relevantPackages);

    try {
      await fs
        .readFile(path.join(process.cwd(), 'package.json'), 'utf-8')
        .then(async (contents) => {
          let pkg = JSON.parse(contents);
          // Route through default ${pkg}/backend resolution. The app's
          // package.json `exports`./backend field handles dev vs prod:
          //   "exports": {
          //     "./backend": {
          //       "development": "./src/backend.ts",
          //       "default": "./lib/esm/backend.js"
          //     }
          //   }
          // Removed plan-010 D10: the source-direct
          // path.join(cwd, 'src', 'backend.ts') override that forced TS
          // runtime loading. Vite SSR's ssrLoadModule handles the
          // transform; production runs from lib/esm/.
          await this.indexPackageBackendProviders(pkg.name, false);
        });
    } catch (err) {
      // Already logged where it was thrown; it must reach start().
      if (isFatalError(err)) throw err;
      console.warn(err);
    }
  }

  /**
   * Index the backend providers of every linked package in the app's
   * dependency tree, dependencies first. Workspace members (`localPackages`)
   * are also imported whole, as before; for anything else only its `/backend`
   * entry is loaded — resolved from the directory discovery found the package
   * in, and skipped without an import when the package has none.
   */
  private async indexLinkedDependencyProviders(
    localPackages: Map<string, { packageName: string; path: string }>
  ) {
    const started = Date.now();
    const installed: string[] = [];
    const ordered = discoverLinkedDependencies(process.cwd(), this.package);
    // A workspace member the walk cannot reach through node_modules still
    // loads, after the rest, as it always did.
    const remaining = new Set(localPackages.keys());
    this.linkedPackageDirs ??= new Map();
    for (const dep of ordered) {
      this.linkedPackageDirs.set(dep.packageName, dep.path);
      this.warnIfInstalledMoreThanOnce(dep);
    }
    for (const [packageName, local] of localPackages) {
      if (!this.linkedPackageDirs.has(packageName) && local?.path) {
        let dir = local.path;
        try {
          dir = fsNative.realpathSync(dir);
        } catch {}
        this.linkedPackageDirs.set(packageName, dir);
      }
    }
    for (const { packageName } of ordered) {
      const isLocal = remaining.delete(packageName);
      await this.ensurePackageBackendProviders(packageName);
      if (isLocal) {
        await this.indexLincdPackage(packageName);
      } else if (
        this.genericProviders.get(packageName) ||
        this.shapeProviders.get(packageName)?.length
      ) {
        installed.push(packageName);
      }
    }
    for (const packageName of remaining) {
      await this.ensurePackageBackendProviders(packageName);
      await this.indexLincdPackage(packageName);
    }
    if (installed.length > 0) {
      console.log(
        paint('gray', 
          `[linked] indexed backend providers of ${ordered.length} linked package(s) in ${
            Date.now() - started
          }ms; installed ones with providers: ${installed.join(', ')}`
        )
      );
    }
  }

  /**
   * Two installed copies of one linked package mean two copies of its module
   * state, and only one of them can own the backend. The one the app resolves
   * is loaded (see discoverLinkedDependencies); the other is never loaded.
   */
  private warnIfInstalledMoreThanOnce(dep: {
    packageName: string;
    path: string;
    copies?: { path: string; version?: string }[];
  }) {
    const copies = dep.copies ?? [];
    this.warnedDuplicateInstalls ??= new Set();
    if (copies.length < 2 || this.warnedDuplicateInstalls.has(dep.packageName)) {
      return;
    }
    this.warnedDuplicateInstalls.add(dep.packageName);
    const list = copies
      .map((c) => `${c.version ?? '?'} at ${c.path}`)
      .join(', ');
    console.warn(
      paint('yellow', 
        `[linked] ${dep.packageName} is installed ${copies.length} times (${list}); loaded ${dep.path}. Run npm dedupe.`
      )
    );
  }

  /**
   * The directory a package's backend is resolved from: the copy discovery
   * chose, or — for a package outside the linked tree, reached only by a lazy
   * /call — the copy the app itself resolves.
   */
  private packageDirFor(pkg: string): string | null {
    const known = this.linkedPackageDirs?.get(pkg);
    if (known) return known;
    const installed = readInstalledPackage(pkg, process.cwd());
    if (!installed) return null;
    try {
      return fsNative.realpathSync(installed.root);
    } catch {
      return installed.root;
    }
  }

  /**
   * Index a package's backend providers once. Shared by boot and the lazy
   * path in callBackendMethod / callShapeMethod. `onSourceChange` bypasses it
   * on purpose: an HMR reload must re-index.
   */
  async ensurePackageBackendProviders(pkg: string, warnIfNotFound = false) {
    if (this.genericProviders.has(pkg) && this.shapeProviders.has(pkg)) {
      return;
    }
    let indexing = this.providerIndexing.get(pkg);
    if (!indexing) {
      indexing = this.indexPackageBackendProviders(pkg, warnIfNotFound).then(
        () => undefined
      );
      this.providerIndexing.set(pkg, indexing);
    }
    try {
      await indexing;
    } finally {
      this.providerIndexing.delete(pkg);
    }
  }

  /**
   * Node's `import()`. Called with the absolute file URL of a resolved backend
   * entry (see resolveBackendEntry), never a bare name.
   */
  protected importModule(specifier: string): Promise<any> {
    return import(/* @vite-ignore */ specifier);
  }

  /**
   * Filters local workspace packages to only those reachable from the app's
   * dependency tree. Mirrors the logic used by `buildAll` in lincd-cli.
   */
  private filterPackagesByDependencyTree(
    allPackages: Map<string, { packageName: string; path: string }>,
    appPackageJson: any
  ): Map<string, { packageName: string; path: string }> {
    const relevantPackages = new Map<
      string,
      { packageName: string; path: string }
    >();
    const packagesToCheck = new Set<string>();
    const processedPackages = new Set<string>();

    // Start with direct dependencies from the app
    if (appPackageJson.dependencies) {
      for (const dep of Object.keys(appPackageJson.dependencies)) {
        if (allPackages.has(dep)) {
          packagesToCheck.add(dep);
        }
      }
    }

    // Recursively follow each package's dependencies
    while (packagesToCheck.size > 0) {
      const packageName = packagesToCheck.values().next().value;
      packagesToCheck.delete(packageName);
      if (processedPackages.has(packageName)) {
        continue;
      }
      processedPackages.add(packageName);
      const packageDetails = allPackages.get(packageName);
      if (packageDetails) {
        relevantPackages.set(packageName, packageDetails);
        const pkg = getPackageJSON(packageDetails.path);
        if (pkg?.dependencies) {
          for (const dep of Object.keys(pkg.dependencies)) {
            if (allPackages.has(dep) && !processedPackages.has(dep)) {
              packagesToCheck.add(dep);
            }
          }
        }
      }
    }

    return relevantPackages;
  }

  async resizeImage(req, res) {
    //check if the w or h query parameters are set
    let width = req.query.w;
    let height = req.query.h;
    //if not
    if (!width && !height) {
      //redirect to the original image
      res.redirect(req.originalUrl.replace('/resized', '/uploads'));
      return;
    }

    let imageFileName = req.query.src; // example: https://cdnurl.com/uploads/1710814765388-935b511c9_cropped.jpeg
    const accessURL = LinkedFileStorage.accessURL;

    if (imageFileName) {
      // `src` may only name an image this app already stores. Before this check
      // the value went straight to fetch(), which made the route an open proxy
      // into its own network -- cloud metadata, localhost, private ranges -- and
      // the response was then written into the PUBLIC file store and the caller
      // redirected to it, so anything reachable was persisted, not just leaked.
      //
      // resolveResizeSource compares parsed origins (a startsWith check is
      // defeated by https://cdn.example.com.evil.com) and hands back the key,
      // which must also exist in the store before anything is requested.
      const source = resolveResizeSource(imageFileName, accessURL);

      if (!source.allowed) {
        res.status(400).send({ error: 'Unsupported image source' });
        return;
      }

      // Two candidates, because the stores disagree on whether the public URL
      // includes the upload mount -- see resolveResizeSource. Fail-closed: if
      // neither shape is held, nothing is fetched.
      const storedKey = await findStoredKey(source.keys, (key) =>
        LinkedFileStorage.fileExists(key)
      );

      if (!storedKey) {
        res.status(404).send({ error: 'Could not fetch image from URL' });
        return;
      }

      // extract the base name and extension from the key the store actually
      // holds, not from the URL path.
      //
      // These differ: LocalFileStore serves `accessURL + /uploads/ + key`, so
      // deriving the destination from the URL gave it an extra `uploads/`
      // segment and resized files landed in data/uploads/uploads/resized/.
      // S3FileStore serves the key directly, so for it the two are the same --
      // which is why this went unnoticed. Deriving from the key is correct for
      // both.
      const { name, ext } = path.parse(storedKey);

      // Sharp READS svg but cannot WRITE it, so an SVG source is rasterized to
      // PNG below. The cache key has to say so: storing PNG bytes under a `.svg`
      // key would also mean serving them as `image/svg+xml`, since the cache-hit
      // branch types the response from this extension.
      const outputExt = ext.toLowerCase() === '.svg' ? '.png' : ext;

      // append the width and height parameters to the base name
      // example: 935b511c9_cropped_w190.jpeg or 935b511c9_cropped_w190h190.jpeg
      //
      // The underscore is emitted once, before either dimension, rather than as
      // part of the width segment. With it inside the width, a height-only
      // request produced `logoh30.jpeg` here while the local branch below --
      // which has always written the separator unconditionally -- produced
      // `logo_h30.jpeg` for the same request. The two halves of one route
      // disagreed on the cache key.
      const newName = `${name}_${width ? 'w' + width : ''}${
        height ? 'h' + height : ''
      }`;

      // the destination key, alongside the original
      // example: uploads/935b511c9_cropped.jpeg -> uploads/resized/935b511c9_cropped_w190.jpeg
      // and for a LocalFileStore key: photo.jpg -> resized/photo_w190.jpg
      const keyDir = path.dirname(storedKey);
      const newPathname = path.join(
        keyDir === '.' ? '' : keyDir,
        'resized',
        `${newName}${outputExt}`
      );

      const resizedImageFileName = newPathname.startsWith('/')
        ? newPathname.slice(1)
        : newPathname;

      if (this.resizePathsMap.has(resizedImageFileName)) {
        res.redirect(this.resizePathsMap.get(resizedImageFileName));
        return;
      }

      // check if the resized image already exists in the CDN
      const imageExists: boolean = await LinkedFileStorage.fileExists(
        resizedImageFileName
      );

      // if exists, redirect to the resized image
      if (imageExists) {
        const resizedPathOnCdn: string = accessURL + '/' + resizedImageFileName;
        //save to cache
        this.resizePathsMap.set(resizedImageFileName, resizedPathOnCdn);
        //redirect this request to the resized image
        res.redirect(resizedPathOnCdn);
        return;
      } else {
        console.log(
          `${process.pid} - ${
            process.env.PORT
          }: Resizing image: ${imageFileName} to ${width} x ${height || ''}`
        );
        //in multicore development, we need to access the site from 127.0.0.1, and so all requests need to go there
        // // if (process.env.NODE_ENV === 'development' && process.env.NUM_WORKER_PROCESSES) {
        // //   imageFileName = imageFileName.replace('localhost', '127.0.0.1');
        // // }

        // Read the bytes out of the store rather than fetching its public URL.
        //
        // Once `src` has to name an image the store already holds, fetching is
        // a round-trip to ask a web server for a file this process can open --
        // over the loopback interface, for a LocalFileStore. Reading directly
        // is faster, and it means the route makes no outbound request at all:
        // there is no origin to re-check after a redirect, no timeout to tune
        // and no response size to cap, because there is no response.
        const image = await LinkedFileStorage.getFile(storedKey);

        // if image is null or empty, return 404
        if (!image?.length) {
          res.status(404).send({ error: 'Could not fetch image from URL' });
          return;
        }

        // get the format of the image
        let format;
        try {
          format = await sharp(image)
            .metadata()
            .then((meta) => meta.format);
        } catch (err) {
          console.warn('Unsupported image format: ' + err);
          res.status(400).send({ error: 'Unsupported image format' });
          return;
        }

        // Sharp reads SVG but has no SVG encoder, so `.toFormat('svg')` throws
        // and every resize of an SVG failed. Rasterize to PNG instead — lossless,
        // and it matches the `.png` cache key chosen above.
        const outputFormat = format === 'svg' ? 'png' : format;

        // set the output options based on the format for quality and compression
        let outputOptions;
        switch (outputFormat) {
          case 'jpeg':
            outputOptions = { quality: 90 };
            break;
          case 'png':
            outputOptions = { compressionLevel: 9 };
            break;
          case 'webp':
            outputOptions = { quality: 90 };
            break;
          // add more formats here
          default:
            outputOptions = {};
        }

        // resize the image
        const resizedImage: Buffer = await sharp(image)
          .resize(
            width ? parseInt(width) : null,
            height ? parseInt(height) : null
          )
          .toFormat(outputFormat, outputOptions)
          .toBuffer()
          .catch((err) => {
            console.warn('Could not resize image: ' + err);
            return null;
          });

        // if resizedImage is null, return 500
        if (!resizedImage) {
          res.status(500).send({ error: 'Could not resize image' });
          return;
        }

        // upload the resized image to the CDN
        const resizedPathOnCdn = await LinkedFileStorage.saveFile(
          newPathname,
          resizedImage
        );

        //save to cache
        this.resizePathsMap.set(resizedImageFileName, resizedPathOnCdn);
        //redirect this request to the resized image
        res.redirect(resizedPathOnCdn);
        return;
      }
    } else {
      imageFileName = req.originalUrl.split('/resized/')[1]?.split('?')[0];
    }

    // Both halves of this route now read and write through LinkedFileStorage.
    //
    // This branch used to hardcode <cwd>/data/uploads for both, which meant it
    // could only ever work for a LocalFileStore: an app configured with S3 kept
    // its uploads in the bucket, so every request here looked on a local disk
    // that had nothing on it and 404'd. Going through the store also removes the
    // need to create the cache directory by hand -- LocalFileStore.saveFile
    // makes its own parent folders, which is why the mkdirSync that used to sit
    // here (commented out, so it silently did nothing) is gone rather than
    // restored.
    const [trueFileName, ...extensions] = imageFileName.split('.');
    const sourceExtension = extensions.join('.');

    // Same rasterization as the branch above: sharp reads SVG but cannot write
    // it. `extension` is what the cached derivative actually IS, and is what
    // `sendStoredFile` types the response with, so it has to be the OUTPUT
    // format rather than the source's.
    const extension =
      sourceExtension.toLowerCase() === 'svg' ? 'png' : sourceExtension;

    const resizedKey = path.join(
      path.dirname(imageFileName) === '.' ? '' : path.dirname(imageFileName),
      'resized',
      `${path.basename(trueFileName)}_${width ? 'w' + width : ''}${
        height ? 'h' + height : ''
      }.${extension}`
    );

    // The resize cache is its own purpose, so an app can keep derivatives on a
    // local disk while its uploads live in S3, or share one store for both.
    // Unconfigured, it falls back to the default store, which is the previous
    // behaviour for anyone who never thinks about it.
    const cacheStore = getResizedImagesStore();
    const sendStoredFile = async (store: IFileStore, key: string) => {
      const bytes = await store.getFile(key);
      if (!bytes) {
        return false;
      }
      res.type(extension || 'bin').send(bytes);
      return true;
    };

    if (await cacheStore.fileExists(resizedKey)) {
      if (await sendStoredFile(cacheStore, resizedKey)) {
        return;
      }
    }

    const uploadsStore = LinkedFileStorage.getStore(FileStorePurposes.uploads);
    const original = await uploadsStore.getFile(imageFileName);

    if (!original) {
      console.warn('Could not find original image at ' + imageFileName);
      res.status(404).send({ error: 'Could not find original image' });
      return;
    }

    let resized: Buffer;
    try {
      const pipeline = sharp(original).resize(
        width ? parseInt(width) : null,
        height ? parseInt(height) : null
      );
      // Without this, sharp writes in the INPUT format, which for an SVG source
      // means asking for an encoder it does not have.
      resized = await (sourceExtension.toLowerCase() === 'svg'
        ? pipeline.png({ compressionLevel: 9 })
        : pipeline
      ).toBuffer();
    } catch (err) {
      console.warn('Could not resize image: ' + err);
      res.status(500).send({ error: 'Could not resize image' });
      return;
    }

    // preventDuplicates: false because this is a cache keyed by name. Letting
    // the store pick a fresh name on collision would write a second copy for
    // every request and never hit the cache.
    //
    // A failure here is logged, not fatal: the resize succeeded, so the caller
    // still gets its image and only the caching is lost. It used to be
    // swallowed and then followed by sendFile on a file that was never written,
    // which turned a cache miss into a 404 with nothing in the response to say
    // why -- and, on the error path, into a second send after the 500.
    try {
      await cacheStore.saveFile(resizedKey, resized, {
        preventDuplicates: false,
      });
    } catch (err) {
      console.warn('Could not cache resized image at ' + resizedKey + ': ' + err);
    }

    res.type(extension || 'bin').send(resized);
  }

  async indexLincdPackage(pkg: string, warnIfNotFound: boolean = false) {
    if (pkg === this.package.name) {
      return;
    }
    try {
      // console.log(`🔍 Loading package: ${pkg}`);
      // console.log(
      //   `🔍 Module resolution for ${pkg}:`,
      //@ts-ignore
      //   await import.meta.resolve(pkg)
      // );
      // plan-011 §P6 — prefer Vite's SSR loader so workspace packages register
      // on the SINGLE @_linked/core instance the rest of the SSR graph uses.
      // The bare Node `import()` fallback resolves `default`→lib, evaluating a
      // SECOND core copy (benign post-§P1, but a needless second instance).
      // Node import stays as the fallback when Vite isn't active (production /
      // Node-only CLI commands). Mirrors indexPackageBackendProviders.
      const vite: any = (this.config.server as any)?.vite;
      if (vite && typeof vite.ssrLoadModule === 'function') {
        await vite.ssrLoadModule(pkg);
      } else {
        // @vite-ignore — dynamic specifier is intentional: this checks
        // whether `pkg` is resolvable at runtime, then catches the error.
        // eslint-disable-next-line no-unsanitized/method
        await import(/* @vite-ignore */ pkg);
      }
      // console.log(`✅ Successfully loaded: ${pkg}`);
    } catch (e) {
      if (isFatalError(e)) {
        logFatalError(pkg, 'module load', e, this.booting);
        if (this.booting) throw e;
        return;
      }
      let providerNotFound =
        e.code === 'MODULE_NOT_FOUND' &&
        e.message.indexOf(`Cannot find package '${pkg}'`) !== -1;
      if (providerNotFound) {
        // console.warn('Error loading ' + providerPath + ': ' + e.stack);
        if (warnIfNotFound) {
          console.warn(
            paint('magenta', 
              `Could not load package ${pkg}`,
              typeof module !== 'undefined' && typeof exports !== 'undefined'
                ? //@ts-ignore
                  ' at ' + (await import.meta.resolve(pkg))
                : ''
            )
          );
        }
      } else {
        console.warn(
          paint('red', 
            `Error loading '${pkg}' ${
              typeof module !== 'undefined' && typeof exports !== 'undefined'
                ? //@ts-ignore
                  ' at ' + (await import.meta.resolve(pkg))
                : ''
            }: ${e.message}\n`
          ),
          e.stack
        );
      }
    }
  }
  async indexPackageBackendProviders(
    pkg: string,
    warnIfNotFound: boolean = false
  ) {
    let backendProviderExports;
    let genericBackendProvider = null;
    let shapeProviders = [];
    const vite: any = (this.config.server as any)?.vite;
    // In dev, load a package's backend with the loader that owns the package
    // (see isBundledBySsr): Vite for the app itself and for what the SSR
    // runner bundles (workspaces, SSR_ENTRY_PACKAGES), Node for what it
    // leaves external (registry installs). ssrLoadModule of an EXTERNAL
    // package's /backend evaluated that package a second time, apart from the
    // copy the app's own imports reach.
    const viteOwnsPackage =
      !!vite &&
      typeof vite.ssrLoadModule === 'function' &&
      (pkg === this.package?.name ||
        isBundledBySsr(pkg, ssrNoExternalOf(vite)));

    // Decide whether there IS a backend before importing anything. A package
    // without one is the normal case (most linked packages have none) and is
    // quiet; once a backend file is known to exist, any failure to load it is
    // a real error. This used to be decided after the fact, by matching the
    // loader's error text — which Node and Vite word differently, so a nested
    // package's "Cannot find package" was reported as a broken backend.
    let entry: string | null = null;
    let load: (() => Promise<any>) | null = null;
    if (pkg === this.package?.name) {
      // The app's own backend cannot be imported by name: a self-reference
      // resolves only from inside the package that declares it, and this code
      // lives in node_modules/@_linked/server. Load it by path.
      const cwd = process.cwd();
      if (viteOwnsPackage) {
        const source = path.join(cwd, 'src', 'backend.ts');
        if (fsNative.existsSync(source)) {
          entry = source;
          load = () => vite.ssrLoadModule('/src/backend.ts');
        }
      } else {
        entry = [
          path.join(cwd, 'lib', 'backend.js'),
          path.join(cwd, 'src', 'backend.ts'),
        ].find((f) => fsNative.existsSync(f)) ?? null;
        if (entry) {
          const url = pathToFileURL(entry).href;
          load = () => this.importModule(url);
        }
      }
    } else {
      const dir = this.packageDirFor(pkg);
      let json: any = null;
      if (dir) {
        try {
          json = JSON.parse(
            fsNative.readFileSync(path.join(dir, 'package.json'), 'utf-8')
          );
        } catch {}
      }
      if (dir && json) {
        if (viteOwnsPackage) {
          // Vite resolves a bundled package with the `development` condition
          // (a workspace's `./backend` may point at src only there). It is
          // still loaded by its bare name, so it is the same module id the
          // rest of the SSR graph imports.
          entry = resolveBackendEntry(dir, json, [
            'development',
            ...NODE_IMPORT_CONDITIONS,
          ]);
          if (entry) load = () => vite.ssrLoadModule(`${pkg}/backend`);
        } else {
          // Node caches ESM by resolved real file URL, and a bare import of
          // `<pkg>/backend` from the app resolves to this same real path — so
          // loading it by URL yields the instance the app's own imports get.
          entry = resolveBackendEntry(dir, json, NODE_IMPORT_CONDITIONS);
          if (entry) {
            const url = pathToFileURL(entry).href;
            load = () => this.importModule(url);
          }
        }
      }
    }

    if (!load) {
      if (warnIfNotFound) {
        console.warn(
          paint('magenta', `Could not find backend file of package ${pkg}. 
        Check:\n
          - Make sure backend.ts exists and is included in tsconfig.json\n
          - Make sure the package name in src/package.ts matches the package name in package.json`)
        );
      }
    } else {
      // Loud, naming the package and the file, and contained: one package's
      // broken backend does not stop the others from loading.
      let loaded = false;
      await runProviderHook(
        pkg,
        `backend ${entry}`,
        async () => {
          backendProviderExports = await load();
          loaded = true;
        },
        this.booting
      );
      if (loaded) {
        for (const key of Object.keys(backendProviderExports)) {
          const providerClass = backendProviderExports[key];
          let provider;
          //always send an instance of the express server
          //TODO: do not create an instance, just save the class and instantiate it when needed
          await runProviderHook(
            pkg,
            `${key} constructor`,
            () => {
              provider = new providerClass(this.server, this);
            },
            this.booting
          );
          if (!provider) continue;
          if (isShapeProvider(provider)) {
            shapeProviders.push(provider);
            if (!Object.getOwnPropertyNames(provider).includes('shape')) {
              console.warn(
                paint('red', `${
                  Object.getPrototypeOf(provider).constructor.name
                } in package ${pkg}
               is not properly linked to a shape. Use public shape = SomeShape.`)
              );
            }
          } else if (genericBackendProvider) {
            console.warn(
              `Package ${pkg} exports two generic backend providers. Only one will work`
            );
          } else {
            genericBackendProvider = provider;
          }
        }
      }
    }
    this.genericProviders.set(pkg, genericBackendProvider);
    this.shapeProviders.set(pkg, shapeProviders);
    return { backendProviderExports, shapeProviders };
  }

  /**
   * Plan-011 phase 2 — HMR re-index entry point.
   *
   * Called by the CLI orchestrator's Vite watcher whenever a `.ts`/`.tsx`
   * file inside a workspace package changes. Disposes the package's
   * existing providers (so routes, listeners, timers don't accumulate),
   * drops them from the registry, and re-runs indexPackageBackendProviders
   * to pick up the freshly-imported module.
   *
   * Dispose calls have a 5 s soft timeout. A hanging dispose logs a
   * warning and is abandoned so HMR doesn't stall the whole dev loop.
   */
  /**
   * Install the client-shell catch-all as the last ordinary layer on the
   * router stack. See utils/spaFallback.ts for why ordering has to be
   * re-asserted rather than assumed.
   */
  private installSpaFallback(): void {
    installSpaFallback(
      this.server,
      this.handleErrors(async (req, res) => {
        //make sure the frontend bundle has finished building
        // await this.waitForWebpack();
        this.render(req, res);
      })
    );
  }

  async onSourceChange(pkg: string): Promise<void> {
    const disposeWithTimeout = async (p: any, label: string) => {
      if (!p?.dispose) return;
      try {
        await Promise.race([
          Promise.resolve().then(() => p.dispose()),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`dispose timeout after 5s`)),
              5000
            )
          ),
        ]);
      } catch (err: any) {
        console.warn(
          paint('yellow', `[linked] ${label} dispose failed: ${err.message}`)
        );
      }
    };

    const generic = this.genericProviders.get(pkg);
    if (generic) {
      await disposeWithTimeout(generic, `${pkg} generic provider`);
      this.genericProviders.delete(pkg);
    }

    const shapeProvs = this.shapeProviders.get(pkg) ?? [];
    for (const p of shapeProvs) {
      await disposeWithTimeout(
        p,
        `${pkg} ${Object.getPrototypeOf(p)?.constructor?.name ?? 'shape provider'}`
      );
    }
    this.shapeProviders.delete(pkg);

    await this.indexPackageBackendProviders(pkg, true);

    // Run the boot lifecycle on the FRESHLY-loaded provider so it
    // re-registers its Express routes/middleware after dispose. Without
    // this, dispose() tears the old routes off and the new instance is
    // constructed but never gets a chance to register the replacements.
    const fresh = this.genericProviders.get(pkg);
    if (fresh?.setupBeforeControllers) {
      try {
        await fresh.setupBeforeControllers();
      } catch (err: any) {
        console.warn(
          paint('yellow', 
            `[linked] ${pkg} setupBeforeControllers after reload failed: ${err.message}`
          )
        );
      }
    }
    const freshShapes = this.shapeProviders.get(pkg) ?? [];
    for (const p of freshShapes) {
      if (p?.setupBeforeControllers) {
        try {
          await p.setupBeforeControllers();
        } catch (err: any) {
          console.warn(
            paint('yellow', 
              `[linked] ${pkg} shape-provider setupBeforeControllers after reload failed: ${err.message}`
            )
          );
        }
      }
    }

    // Providers just re-registered their routes, which express can only APPEND
    // — i.e. behind the catch-all installed at boot. Put it back at the end so
    // those routes stay reachable. Safe here: every registration above has
    // completed, so no provider is mid-capture of its own layer indices.
    repinSpaFallback(this.server);
  }

  async processBackendMethodCall(request, response) {
    this.noCache(response);
    await this.initRequest(request, response);
    let { pkg, method } = request.params;
    let { args } = JSONParser.parseObject<{ args }>(request.body);

    return this.callBackendMethod(pkg, method, args, request, response).then(
      (result) => {
        //some methods of backend providers may choose to work with request/response directly and will not return anything
        //so only if a result is returned
        if (typeof result !== 'undefined') {
          //do we convert it to JSON and send it to the frontend
          this.sendJson(response, result);
        } else {
          //in other cases, we still need to close the request and send an empty response
          if (!response.headersSent) {
            this.sendJson(response, null);
          }
        }
      }
    );
  }

  noCache(response) {
    response.setHeader('Surrogate-Control', 'no-store');
    response.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
    response.setHeader('Expires', '0');
  }
  async processAPICall(
    request,
    response,
    method: 'get' | 'post' | 'put' | 'delete'
  ) {
    this.noCache(response);
    const result = await this.api.process(request, response, method);
  }
  // async processQuery(request, response) {
  //
  //   this.api.process(request, response);
  // }
  async processShapeMethodCall(request, response) {
    this.noCache(response);
    // console.log('process shape call');
    // response.on('finish', function() {
    //   console.log('shape method call request finish');
    // });
    //
    // response.on('close', function() {
    //   console.log('close');
    // });
    //
    // response.on('end', function() {
    //   console.log('end');
    // });
    //
    // response.on('header', function() {
    //   console.log('header');
    //   console.log(response.statusCode);
    // });

    await this.initRequest(request, response);
    let { pkg, shape, method } = request.params;
    let { shapeURI, instanceNode, args } = JSONParser.parseObject<{
      shapeURI: string;
      instanceNode: { id: string } | null;
      args: any[];
    }>(request.body);

    if (!shapeURI) {
      if (request.query?.shapeURI) {
        shapeURI = request.query?.shapeURI;
      } else {
        response.status(500).send({
          error: 'Invalid server call request: ' + request.originalUrl,
        });
        console.warn(
          paint('red', 'Invalid server call request: ' + request.originalUrl)
        );
        return;
      }
    }
    return this.callShapeMethod(
      pkg,
      method,
      shapeURI,
      instanceNode,
      args,
      request,
      response
    ).then((result) => {
      //we return json if something was returned or, if nothing was returned, we still close the request if the method has not accessed response itself already to send things over
      if (typeof result !== 'undefined' || !response.headersSent) {
        this.sendJson(response, result);
      }
    });
  }

  async callShapeMethod(
    pkg: string,
    method: string,
    shapeURI: string,
    instanceNode: { id: string } | null,
    args: any[],
    request,
    response
  ) {
    //- index module providers if not done yet
    if (!this.shapeProviders.has(pkg)) {
      await this.ensurePackageBackendProviders(pkg, true);
    }

    let packageShapeProviders = this.shapeProviders.get(pkg);

    let findProviderForShape = (nodeShapeId: string) => {
      return packageShapeProviders.find((provider) => {
        //access the static shape (which is a linkedShape() / Shape class)
        //then access the SHACL NodeShape of that shape class, and its id
        return (
          isShapeProvider(provider) &&
          provider.shape?.shape?.id === nodeShapeId
        );
      });
    };

    let providerMethodFailed = false;
    try {
      //- find matching provider
      let shapeClass = getShapeClass(shapeURI);
      let shapeProvider: ShapeProvider = shapeClass?.shape
        ? findProviderForShape(shapeClass.shape.id)
        : undefined;
      if (!shapeProvider && shapeClass) {
        let superShapeClasses = getSuperShapesClasses(
          shapeClass as unknown as typeof Shape
        );
        for (let superShapeClass of superShapeClasses) {
          let superShapeProvider = findProviderForShape(
            superShapeClass.shape?.id
          );
          if (superShapeProvider) {
            shapeProvider = superShapeProvider;
            break;
          }
        }
      }
      // No provider for this shape (e.g. it isn't registered on this side).
      // Framework packages are kept single-instance by the cli vite-config's
      // `optimizeDeps.exclude`, so a mismatch here signals a real
      // misconfiguration. Answer 501 (via handleErrorsJson) rather than an empty
      // 200; direct backend callers get a rejected ServerCallError.
      if (!shapeProvider) {
        console.warn(
          `[LinkedServer] callShapeMethod: no provider for '${shapeURI}' ` +
            `(pkg '${pkg}', method '${method}').`
        );
        throw new ServerCallError(501, `No provider for ${pkg}/${method}`);
      }

      if (shapeProvider) {
        //NOTE: if this is a direct call from backend to backend, we won't know the request & response here because those don't get passed to the Server utility
        //if this is an issue, we need to see how we can get those back
        if (request && response) {
          //give the provider a chance to prepare for this request
          //wrap the call in a promise and wait for it, because providers MAY return a promise
          await Promise.resolve(shapeProvider.initRequest(request, response));
        }

        //see if the shapeProvider implements the called method
        if (shapeProvider[method]) {
          //prepare the first argument
          //we want to convert the instance node into an instance of the shape that this shapeProvider provides for
          //let's find the shape class
          if (shapeProvider.shape) {
            //instance nodes are not always sent. A shape can also call a shape provider from a static method without a shape instance.
            if (instanceNode) {
              let providerShapeClass = shapeProvider.shape;
              let instance = new (providerShapeClass as any)({
                id: instanceNode.id,
              });

              //always send instanceNode as first argument to static provider methods
              args.unshift(instance);
            }

            try {
              //call the method with the given arguments
              let result = await Promise.resolve(
                shapeProvider[method].apply(shapeProvider, args)
              );
              return result;
            } catch (e) {
              console.warn(
                `Error whilst calling ${
                  Object.getPrototypeOf(shapeProvider).constructor.name
                }.${method}(): `,
                e
              );
              // Rethrow so the HTTP route answers with an error status (via
              // handleErrorsJson) instead of `200 null`, and direct backend
              // callers get a rejected promise.
              providerMethodFailed = true;
              throw e;
            }
          } else {
            console.warn(
              `${
                Object.getPrototypeOf(shapeProvider).constructor.name
              } does not define its own 'static shape' property. Please connect the provider to a shape.`
            );
          }
        } else {
          console.warn(
            `${
              Object.getPrototypeOf(shapeProvider).constructor.name
            } does not have a method called ${method}`
          );
          throw new ServerCallError(501, `No provider for ${pkg}/${method}`);
        }
      }
    } catch (err) {
      if (!providerMethodFailed && !ServerCallError.is(err)) {
        console.warn(`Error whilst trying to access provider of ${pkg}: `, err);
      }
      throw err;
    }
    return null;
  }

  handleErrors(fn) {
    return async function (req, res, next) {
      try {
        return await fn(req, res);
      } catch (x) {
        console.log(x);
        next(x);
      }
    };
  }

  handleErrorsJson(fn) {
    return async (req, res, next) => {
      try {
        return await fn(req, res);
      } catch (err) {
        // A ServerCallError (e.g. 501 for a call no provider handles) carries
        // its own status and a message that is safe to send to the client.
        if (ServerCallError.is(err)) {
          return this.sendError(res, err.status, err.message);
        }
        this.sendError(
          res,
          500,
          'internal server error' + (isDevelopment ? ': ' + err?.stack : ''),
          'internal server error: ' + err?.stack
        );
      }
    };
  }

  sendError(res, statusCode = 500, message, logMessage?: string) {
    res?.status(statusCode);
    if (message) {
      res?.send({ error: message });
      console.warn(paint('red', logMessage || message));
    }
  }

  /**
   * The stylesheets a dev (Vite) page render needs, inlined into
   * `<style id="ssr-css">` so the first paint is styled before Vite's client
   * injects the same CSS.
   *
   * Scoped to what the app module and the matched routes' pages import
   * statically (see utils/ssrCss `ssrCssScope`). The dev server preloads every
   * page into the module graph, so the whole graph is every page's CSS —
   * megabytes per request in a large app. When the scope cannot be
   * established (no routes config, a route rendered through a function, a
   * module not found) it falls back to the whole graph.
   *
   * Ids are kept in the combined graph's order, so the cascade order of what
   * remains is unchanged.
   */
  private async collectViteSsrCss(
    vite: any,
    App: unknown,
    matchedRoutes: RouteConfig[] | null,
  ): Promise<string> {
    if (!vite?.moduleGraph?.idToModuleMap) return '';
    // Note: Tailwind v4 `@theme` directives in app theme CSS files are
    // NOT processed at SSR collection time — the @tailwindcss/vite
    // plugin expands them at production build only. In dev mode, the
    // theme variables (—color-primary-*, etc.) are injected by Vite's
    // runtime AFTER client hydration, which causes a brief flash of
    // unthemed content (logos render black until ~hydration+200ms).
    // Production (vite build) is unaffected — the static main.css
    // contains expanded :root variables.
    let scope: Set<string> | null = null;
    const ssrGraph = vite.environments?.ssr?.moduleGraph;
    if (ssrGraph?.idToModuleMap && App && matchedRoutes) {
      const pages: unknown[] = [];
      let known = true;
      for (const route of matchedRoutes) {
        const component = await resolveRouteComponent(route);
        if (component === undefined) {
          known = false;
          break;
        }
        if (component !== null) pages.push(component);
      }
      if (known) {
        scope = ssrCssScope(ssrGraph.idToModuleMap.values(), {
          app: App,
          pages,
        });
      }
    }
    // Read only now: resolving a lazy route above can load its page, and the
    // combined graph's id map is a view built when it is read.
    const graphIds = [
      ...(vite.moduleGraph.idToModuleMap as Map<string, unknown>).keys(),
    ];
    const ids = scope ? graphIds.filter((id) => scope!.has(id)) : graphIds;
    // Only real stylesheets, once per file — see utils/ssrCss.
    const inlineUrls = ssrCssInlineUrls(ids, {
      publicDir: vite.config?.publicDir,
    });
    const cssChunks: string[] = [];
    for (const inlineUrl of inlineUrls) {
      try {
        const cssModule = await vite.ssrLoadModule(inlineUrl);
        if (typeof cssModule?.default === 'string') {
          cssChunks.push(cssModule.default);
        }
      } catch {/* skip */}
    }
    return cssChunks.join('\n');
  }

  async render(req, res) {
    res.socket.on('error', (error) => {
      console.error('Fatal socket error', error);
    });

    //when render() is called, the request is always an 'initial page request', and the server which will return HTML (so this is a SSR request)
    //in that case we send data back to the frontend in a <script> tag.
    //We initiate that object here
    if (req['frontendData'] == null) {
      req['frontendData'] = {};
    }

    //if we are caching this page
    if (
      this.config.server?.cachePaths &&
      this.config.server.cachePaths.includes(req.url)
    ) {
      //if there is a cach for this path, send it
      if (this.cachedPaths.has(req.url)) {
        // console.log(req.url + ': Returning cached path');
        const html = this.cachedPaths.get(req.url);
        // res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // res.setHeader('Content-Length', Buffer.byteLength(html, 'utf8').toString());
        // res.status(200).end(html);
        res.send(html);
        return;
      }
    }

    let didError = false;

    let App = this.config.server?.loadAppComponent
      ? await this.config.server.loadAppComponent()
      : null;

    // Vite dev CSS collection (plan-010 iteration 1 — gap A):
    // 1. Preload the matched route's module via ssrLoadModule so all
    //    page-level dependencies (SigninLayout, CreateAccount, etc.)
    //    enter Vite's moduleGraph BEFORE we collect CSS. Without this,
    //    only App's eager imports are in the graph and lazy routes'
    //    CSS would be missing — page renders unstyled until hydration.
    // 2. Once the route is matched, collect the CSS the app and that route's
    //    page import (collectViteSsrCss), each loaded via `?inline` (Vite
    //    returns the processed CSS as the default export).
    // 3. Inject as inline <style> in HTML head (Html.tsx).
    const vite: any = (this.config.server as any)?.vite;
    // Vite SSR module preload (plan-010 iter1 gap A):
    // Pages are loaded lazily via React.lazy — their modules only enter
    // Vite's moduleGraph after the lazy resolves. For SSR CSS collection
    // we need the page modules in the graph BEFORE the first render of
    // each route. The orchestrator passes a preloadPagesFn that lists
    // all page files (typically via `import.meta.glob`); we call
    // ssrLoadModule on each path once. After the first render of a
    // session everything is cached.
    const preloadPagesFn: any = (this.config.server as any)?.viteSsrPreload;
    if (vite?.ssrLoadModule && preloadPagesFn && !(this as any)._viteSsrPreloaded) {
      try {
        const pagePaths: string[] = await preloadPagesFn();
        for (const p of pagePaths) {
          try {
            await vite.ssrLoadModule(p);
          } catch {/* skip — page may not exist or have ssr errors */}
        }
      } catch {/* ignore */}
      (this as any)._viteSsrPreloaded = true;
    }

    await this.initRequest(req, res);
    let { requestLD, requestObject } = await this.getRequestData(req, res);

    //on the backend we need to inform the hook of the request-data value
    //on the frontend it will be read from the HTML
    // setRequestData(requestObject);
    // Abandon and switch to client rendering if enough time passes.
    // Try lowering this to see the client recover.
    // Abandon and switch to client rendering if enough time passes.
    // Try lowering this to see the client recover.
    let stream;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedout = false;
    // const timeout = setTimeout(() => {
    //   stream.abort(`${req.url}: ⏱ SSR stream took too long — force abort`);
    //   if (!res.headersSent) {
    //     res.statusCode = 500;
    //     res.end('SSR timed out');
    //   }
    //   timedout = true;
    // }, 8_000);

    let manifest = this.assets.manifest || {};
    let preloadScripts: string[] = [];
    let preloadStyles: string[] = [];
    let matchedRouteKey: string | null = null;
    // Null until the routes config has loaded: without it, what renders is unknown.
    let matchedRoutes: RouteConfig[] | null = null;
    // Plan-010 Vite dev mode: skip preload resolution entirely. Vite
    // handles dynamic import() at runtime — there are no pre-built
    // chunks to preload, and the webpack-shape fallback would pick up
    // stale bundles on disk (public/bundles/*.bundle.js from a prior
    // webpack build) and link them, breaking hydration.
    // The same decision start() made for the `__viteDev` marker. This used
    // to be re-derived from `latestManifest`, which nothing ever set, so it
    // answered "dev" whenever Vite was attached — even when start() had
    // chosen the build — and the page mixed built CSS with the dev preamble.
    const usingViteDev = this.viteDevServer;

    // Load routes config if available and extract preload chunks for the current route
    if (this.config.server?.loadRoutes) {
      try {
        const routesModule = await this.config.server.loadRoutes();
        const ROUTES: RoutesConfig =
          routesModule.ROUTES ||
          routesModule.default?.ROUTES ||
          (routesModule as RoutesConfig);

        // Match the current request path to a route
        let matchedRoute: RouteConfig | null = null;
        const allMatches: RouteConfig[] = [];
        for (const [key, route] of Object.entries(ROUTES)) {
          if (!route?.path) continue;
          const pathPattern = route.path
            .replace(/:\w+\??/g, '([^/]+)')
            .replace(/\*/g, '.*');
          const regex = new RegExp('^' + pathPattern + '$');
          if (regex.test(req.path)) {
            // Every match, not only the first: React Router may pick a more
            // specific route than this first-match loop, and the dev CSS
            // scope must cover whichever page actually renders.
            allMatches.push(route);
            if (!matchedRoute) {
              matchedRoute = route;
              matchedRouteKey = key;
            }
          }
        }
        matchedRoutes = allMatches;

        // If we found a matching route with preloadChunks, resolve them to URLs (both JS and CSS).
        // Manifest format detection: Vite manifest entries are objects with .file/.css; webpack
        // manifest entries are bare strings. Try Vite shape first, fall back to webpack.
        // Skip entirely in Vite dev mode — no pre-built chunks exist; Vite handles dynamic
        // imports at runtime.
        if (
          !usingViteDev &&
          matchedRoute?.preloadChunks &&
          Array.isArray(matchedRoute.preloadChunks)
        ) {
          // Both lists are built on the base the entry tags use, so a release
          // served from a CDN preloads its route chunks from that release
          // rather than from this app server. See utils/routeAssets.
          const routeAssets = resolveRouteAssets(
            manifest,
            matchedRoute.preloadChunks,
            this.staticAccessURL,
          );
          preloadScripts = routeAssets.scripts;
          preloadStyles = routeAssets.styles;
        }
      } catch (err) {
        console.warn('Failed to resolve preload chunks:', err);
      }
    }

    // Add matched route key to request object for Html component
    req['matchedRouteKey'] = matchedRouteKey;

    const ssrCss = await this.collectViteSsrCss(vite, App, matchedRoutes);
    // Per request, and not enumerable: Html reads `assets.__viteSsrCss` for
    // the inline <style>, but also serialises the whole assets object into
    // `assetManifest` for the client, which never uses it. Enumerable, the
    // collected CSS — megabytes in a large app — went into every page twice.
    // A per-request copy also keeps one render's CSS out of another's.
    const assets = { ...this.assets };
    if (ssrCss) {
      Object.defineProperty(assets, '__viteSsrCss', {
        value: ssrCss,
        enumerable: false,
      });
    }

    stream = renderToPipeableStream(
      <React.StrictMode>
        <StaticRouter location={req.url}>
          <AppContextProvider
            assets={assets}
            requestLD={requestLD}
            requestObject={requestObject}
            preloadScripts={preloadScripts}
            preloadStyles={preloadStyles}
            expressRequest={req}
            expressResponse={res}
          >
            <App />
          </AppContextProvider>
        </StaticRouter>
      </React.StrictMode>,
      {
        // How the client entry boots — dev preamble, ES module, or classic
        // script. See utils/bootstrapEntry.
        ...resolveBootstrapEntry({
          viteDevServer: usingViteDev,
          mainEntryIsModule: this.mainEntryIsModule,
          mainEntry: this.assets['main.js'],
        }),
        onShellReady: function () {
          res.statusCode = didError ? 500 : 200;
          res.setHeader('Content-type', 'text/html');

          // Create a caching transform stream à la mxstbr.com/thoughts/streaming-ssr
          if (
            this.config.server?.cachePaths &&
            this.config.server.cachePaths.includes(req.url)
          ) {
            const bufferedChunks: Buffer[] = [];

            const cacheStream = new Transform({
              transform(chunk, _enc, cb) {
                bufferedChunks.push(chunk); // keep a copy
                cb(null, chunk); // forward unchanged
              },
              flush: (cb) => {
                const html = Buffer.concat(bufferedChunks).toString('utf8');
                this.cachedPaths.set(req.url, html);
                if (this.config.server.cacheTimeout) {
                  setTimeout(
                    () => this.cachedPaths.delete(req.url),
                    this.config.server.cacheTimeout
                  );
                }
                clearTimeout(timeout); // rendering finished → stop timer
                cb();
              },
            });

            // Pipe the caching stream into the real response
            cacheStream.pipe(res);

            // React may **only be piped once**, so pipe it to the cacheStream
            stream.pipe(cacheStream);
          } else {
            stream.pipe(res);
          }
        }.bind(this),
        onShellError(x) {
          didError = true;
          console.error(x);
          // Respond NOW. Without this the socket stays open until the 10s
          // watchdog below fires, turning every render-time crash into an
          // opaque "SSR timed out" with the real error buried in the log.
          clearTimeout(timeout);
          if (res.headersSent) {
            res.end();
            return;
          }
          res.statusCode = 500;
          res.setHeader('Content-type', 'text/plain');
          res.end(
            'SSR render failed before the shell was ready:\n\n' +
              ((x as any)?.stack ?? (x as any)?.message ?? String(x))
          );
        },
      }
    );

    // Abandon and switch to client rendering if enough time passes.
    // Try lowering this to see the client recover.
    timeout = setTimeout(() => {
      stream.abort('⏱ SSR stream took too long — force abort');
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('SSR timed out');
      }
    }, 10_000);

    res.on('close', () => {
      clearTimeout(timeout); // if you're using a safety timeout
    });
  }

  //If we ever need to use multiple webpack entry-points and different bundle names, then uncomment this
  /*getWebpackAssets()
	{
		// const { devMiddleware } = res.locals.webpack;
		// const outputFileSystem = devMiddleware.outputFileSystem;
		// const jsonWebpackStats = devMiddleware.stats.toJson();
		// const { assetsByChunkName, outputPath } = jsonWebpackStats;
		//
		// let normalizedAssets = normalizeAssets(assetsByChunkName.main);
		// let cssAssets = normalizedAssets
		//   .filter((path) => path.endsWith(".css"))
		//   .map((filePath) => outputFileSystem.readFileSync(path.join(outputPath, filePath)))
		//   .join("\n");
		//
		// let jsAssets = normalizeAssets(assetsByChunkName.main)
		//     .filter((path) => path.endsWith(".js"))
		//     .map((path) => `<script src="${path}"></script>`)
		//   .join("\n")}
	}*/

  sendJson(res, obj) {
    let jsonObject = JSONWriter.toJsObject(obj);
    res.json(jsonObject);
  }

  async initRequest(request, response) {
    // initialise the request for all providers, one after the other (order
    // matters: later providers may read what earlier ones put on the request).
    // A provider that throws is logged by package name and skipped.
    for (const [pkg, backendProvider] of this.genericProviders.entries()) {
      if (!backendProvider || typeof backendProvider.initRequest !== 'function') {
        continue;
      }
      await runProviderHook(pkg, 'initRequest', () =>
        backendProvider.initRequest(request, response)
      );
    }
  }

  async getRequestData(
    request,
    response
  ): Promise<{ requestLD: string; requestObject: string }> {
    // Providers return plain JSON data via supplyDataForRequest.
    // requestLD is kept as empty string for now; SSR data seeding will
    // inject query results instead of graph data.
    // A provider that throws (synchronously or not) is logged by package
    // name; the page still renders with the other providers' data.
    let requestData: Record<string, any> = {};
    await Promise.all(
      [...this.genericProviders.entries()].map(([pkg, backendProvider]) => {
        if (
          !backendProvider ||
          typeof backendProvider.supplyDataForRequest !== 'function'
        ) {
          return;
        }
        return runProviderHook(pkg, 'supplyDataForRequest', () =>
          backendProvider.supplyDataForRequest(request, response, requestData)
        );
      })
    );

    let requestLD = '';
    let requestObject = JSONWriter.stringify(request['frontendData']);
    return { requestLD, requestObject };
  }

  async callBackendMethod(
    pkg: string,
    method: string,
    args: any[],
    request,
    response
  ) {
    if (!this.genericProviders.has(pkg)) {
      await this.ensurePackageBackendProviders(pkg, true);
    }

    //retrieve the indexed provider class and create a new instance for this request
    let genericBackendProvider = this.genericProviders.get(pkg);

    let result;
    if (!genericBackendProvider) {
      console.warn(
        `${paint('magenta', 
          pkg
        )} does not have a generic backend provider. If you can edit this package, make sure 'backend.ts' is included in 'tsconfig.json' and that it exports a provider.`
      );
      throw new ServerCallError(501, `No provider for ${pkg}/${method}`);
    }
    //test if there is a matching method in the backend provider
    if (!genericBackendProvider[method]) {
      console.warn(
        `Generic provider '${
          Object.getPrototypeOf(genericBackendProvider).constructor.name
        }' of ${pkg} does not have a method called ${method}`
      );
      throw new ServerCallError(501, `No provider for ${pkg}/${method}`);
    }

    try {
      //TODO: remove init request.
      //TODO: refactor this.request and this.response to a request parameter
      //NOTE: if this is a direct call from backend to backend, we won't know the request & response here because those don't get passed to the Server utility
      //if this is an issue, we need to see how we can get those back
      if (request && response) {
        //initialise the request for this specific provider
        //wrap the call in a promise and wait for it, because providers MAY return a promise
        await Promise.resolve(
          genericBackendProvider.initRequest(request, response)
        );
      }
      // args.push(request);
      // args.push(response);

      //call the method with the given arguments and return the result as json
      result = await Promise.resolve(
        genericBackendProvider[method].apply(genericBackendProvider, args)
      );
    } catch (e) {
      console.warn(
        `Error whilst calling ${method}() in provider ${
          Object.getPrototypeOf(genericBackendProvider).constructor.name
        } of package ${pkg}:\n`,
        e
      );

      // error logging
      LinkedErrorLogging.log(e);
      // Rethrow so the HTTP route answers with an error status instead of `200 null`.
      throw e;
    }
    return result;
  }
}
