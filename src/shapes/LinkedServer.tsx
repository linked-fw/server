'use strict';
import chalk from 'chalk';
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
import { LinkedFileStorage } from '@_linked/core/utils/LinkedFileStorage';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { autoLoadOntologyData } from '@_linked/core/utils/Package';
import {
  getShapeClass,
  getSuperShapesClasses,
} from '@_linked/core/utils/ShapeClass';
import path from 'path';
import process from 'process';
import * as React from 'react';
import { renderToPipeableStream, renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server.js';
import { rimraf } from 'rimraf';
import sharp from 'sharp';
import { Transform } from 'stream';
import { CookieJar } from 'tough-cookie';
import { lincdServer } from '../ontologies/lincd-server.js';
import { linkedShape } from '../package.js';
import {
  resolveStaticAccessURL,
  staticAssetURL,
} from '../utils/releaseManifest.js';
import { resolveRouteAssets } from '../utils/routeAssets.js';
import { indexShapesIntoMemory } from '../utils/Shapes.js';
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
  console.warn(chalk.red('Asynchronous error caught.'));
  console.error(err);

  // error logging
  LinkedErrorLogging.log(err);
});
process.on('unhandledRejection', (err) => {
  console.warn(chalk.red('Unhandled rejection caught.'));
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

@linkedShape
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
  private latestManifest: Record<string, string> | null = null;
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
  //from resizedFileName to full resized path (CDN or similar)
  private resizePathsMap: Map<string, string> = new Map();
  private api: LincdAPI;

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
   * (plan-010 T1e.2). This is the canonical, uniform reuse+create mechanism:
   * whatever shapes the app package registers (published re-exports + generated)
   * get materialized on boot (and re-run on shape-file HMR).
   *
   * Gated to servers whose DEFAULT dataset is a **concrete** materializable store
   * (detected via `rawQuery`) — i.e. an app pointing at its app-data FusekiStore.
   * CN's default is the context-routing `AppDataRouter` (no `rawQuery`; a bare
   * `syncShapes` orphan-read would throw with no active project), so CN is skipped
   * here — it materializes its own pinned native shapes in its storage config.
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
      // data store regardless of per-shape routing/pins — syncShapes(ds) threads
      // ds through the orphan-read + every delete→recreate. (No reliance on
      // "whatever the default resolves to per shape".)
      const thunks = await syncShapes(appData as any);
      // Batched (not all-at-once) so we don't overwhelm Fuseki — the API hands
      // back unexecuted thunks precisely so the caller paces them.
      for (let i = 0; i < thunks.length; i += 8) {
        await Promise.all(thunks.slice(i, i + 8).map((run) => run()));
      }
      console.log(
        `[LinkedServer] materialized ${thunks.length} shape(s) into app-data`,
      );
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

  async start() {
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
    try {
      const viteManifestPath = path.resolve(
        process.cwd(),
        'public/bundles/.vite/manifest.json'
      );
      if (fsNative.existsSync(viteManifestPath)) {
        const manifestRaw = fsNative.readFileSync(viteManifestPath, 'utf-8');
        const viteManifest = JSON.parse(manifestRaw);
        this.assets.manifest = viteManifest;
        // Resolve main entry per Vite manifest shape:
        //   { "src/index.tsx": { file: "assets/main-<hash>.js", css: [...] } }
        const mainEntry =
          viteManifest['src/index.tsx'] ||
          viteManifest['src/index.ts'] ||
          Object.values(viteManifest).find((e: any) => e?.isEntry);
        if (mainEntry?.file) {
          this.assets['main.js'] = staticAsset(`/bundles/${mainEntry.file}`);
          this.mainEntryIsModule = true;
        }
        if (mainEntry?.css?.[0]) {
          this.assets['main.css'] = staticAsset(`/bundles/${mainEntry.css[0]}`);
        }
      }
    } catch (err) {
      console.warn('Could not load bundle manifest:', err);
    }
    // Vite dev marker: when Vite is in use AND no Vite manifest exists yet
    // (= dev mode, no `vite build` run), the HTML renderer skips
    // pre-built CSS/JS link tags. Vite handles asset injection itself.
    if ((this.config.server as any)?.vite && !(this.assets.manifest as any)?.['src/index.tsx']) {
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
    // //accept JSON bodies
    // this.server.use(bodyParser.json({limit: '50mb'}));
    this.server.use(express.json({ limit: '50mb' }));

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

  // get generic backend providers for handle controller methods
  async callGenericBackendProvidersMethod(method: string, ...args: any[]) {
    for (let genericProvider of this.genericProviders.values()) {
      if (!genericProvider || !genericProvider[method]) {
        continue;
      }
      if (typeof genericProvider[method] == 'function') {
        await Promise.resolve(genericProvider[method](...args));
      }
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
    //get all local workspace lincd packages, then filter to only those
    //in this app's dependency tree. This avoids loading npm-installed
    //legacy packages that may use an old version of the core.
    const allLocalPackages = getLincdPackages();
    const localPackageMap = new Map<
      string,
      { packageName: string; path: string }
    >(allLocalPackages.map((pkg) => [pkg.packageName, pkg]));
    const relevantPackages = this.filterPackagesByDependencyTree(
      localPackageMap,
      this.package
    );
    for (let [pkgName, pkg] of relevantPackages) {
      await this.indexPackageBackendProviders(pkgName);
      await this.indexLincdPackage(pkgName);
    }

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
      console.warn(err);
    }
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
      // TODO: restrict resizing to images that are stored by LinkedFileStorage.fileExists()
      // if (imageFileName.startsWith(accessURL)) {
      //   const exists = await LinkedFileStorage.fileExists(
      //     imageFileName.replace(`${accessURL}/`, ''),
      //   );

      // extract the base name and extension from the imageFileName
      // example: /uploads/resized/935b511c9_cropped.jpeg
      const url = new URL(imageFileName);
      const { name, ext } = path.parse(url.pathname);

      // append the width and height parameters to the base name
      // example: 935b511c9_cropped_w190.jpeg or 935b511c9_cropped_w190h190.jpeg
      const newName = `${name}${width ? '_w' + width : ''}${
        height ? 'h' + height : ''
      }`;

      // create a new pathname with dimensions
      // example: /uploads/resized/935b511c9_cropped.jpeg -> /uploads/resized/935b511c9_cropped_w190.jpeg
      const newPathname = path.join(
        path.dirname(url.pathname),
        'resized',
        `${newName}${ext}`
      );

      // remove the leading slash from the pathname
      // example: /uploads/resized/935b511c9_cropped_w190.jpeg -> uploads/resized/935b511c9_cropped_w190.jpeg
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

        // get the image from imageFileName
        const image = await globalThis
          .fetch(imageFileName)
          .then((res) => res.arrayBuffer())
          .then((arrayBuffer) => Buffer.from(arrayBuffer))
          .catch((err) => {
            console.warn('Could not fetch image from URL: ' + err);
            return null;
          });

        // if image is null, return 404
        if (!image) {
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

        // set the output options based on the format for quality and compression
        let outputOptions;
        switch (format) {
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
          .toFormat(format, outputOptions)
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

    //if this request has not been made (and stored on the HD) before
    let [trueFileName, ...extensions] = imageFileName.split('.');
    let extension = extensions.join('.');

    let resizedImageFileName =
      trueFileName +
      '_' +
      (width ? 'w' + width : '') +
      (height ? 'h' + height : '') +
      '.' +
      extension;

    let resizedFilePath = path.join(
      process.cwd(),
      'data',
      'uploads',
      'resized',
      resizedImageFileName
    );

    if (!fsNative.existsSync(resizedFilePath)) {
      //ensure the resized folder exists
      // if (!fsNative.existsSync(path.join(process.cwd(), 'data', 'uploads', 'resized'))) {
      //   fsNative.mkdirSync(path.join(process.cwd(), 'data', 'uploads', 'resized'), {recursive: true});
      // }

      //then lets resize and store the image:
      // resize the image with sharp and return it
      let originalImagePath = path.join(
        process.cwd(),
        'data',
        'uploads',
        imageFileName
      );
      if (!fsNative.existsSync(originalImagePath)) {
        console.warn('Could not find original image at ' + originalImagePath);
        return res.status(404).send({ error: 'Could not find original image' });
      }

      try {
        let image = sharp(originalImagePath);
        image.resize(
          width ? parseInt(width) : null,
          height ? parseInt(height) : null
        );

        //write image to disk
        await image
          .toFile(resizedFilePath)
          .then(() => {
            // console.log('resized image written to disk: ' + resizedFilePath);
          })
          .catch((err) => {
            console.warn(
              'Could not write resized image to disk at ' +
                resizedFilePath +
                ': ' +
                err
            );
          });
        //
        // //get content type from the file extension
        // let contentType;
        // let extension = imageFileName.split('.').pop();
        // switch (extension) {
        //   case 'jpg':
        //   case 'jpeg':
        //     contentType = 'image/jpeg';
        //     break;
        //   case 'png':
        //     contentType = 'image/png';
        //     break;
        //   case 'gif':
        //     contentType = 'image/gif';
        //     break;
        //   default:
        //     contentType = 'image/jpeg';
        // }
        // res.setHeader('Content-Type', contentType);
        // image.pipe(res);
      } catch (err) {
        console.warn(err);
        res.status(500).send({ error: 'Could not resize image' });
      }
    }
    //send the resized image
    res.sendFile(resizedFilePath);
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
      let providerNotFound =
        e.code === 'MODULE_NOT_FOUND' &&
        e.message.indexOf(`Cannot find package '${pkg}'`) !== -1;
      if (providerNotFound) {
        // console.warn('Error loading ' + providerPath + ': ' + e.stack);
        if (warnIfNotFound) {
          console.warn(
            chalk.magenta(
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
          chalk.red(
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
    warnIfNotFound: boolean = false,
    backendIndexFilePath?: string
  ) {
    if (!backendIndexFilePath) {
      backendIndexFilePath = `${pkg}/backend`;
    }
    let backendProviderExports;
    let genericBackendProvider;
    let shapeProviders = [];
    // Plan-010 phase 4/5: when Vite SSR is active, route module loading
    // through vite.ssrLoadModule. This handles the case where the user app
    // is the consuming workspace itself (self-reference like
    // @semantu/create-now/backend), which Node's ESM resolver can't resolve
    // from inside an installed package like @_linked/server.
    const vite: any = (this.config.server as any)?.vite;
    const loadModule = async (specifier: string) => {
      if (vite && typeof vite.ssrLoadModule === 'function') {
        // For the user app's own backend, resolve to ./src/backend.ts directly.
        // Vite reads the app's package.json exports.development condition.
        if (specifier === `${this.package.name}/backend`) {
          return await vite.ssrLoadModule('/src/backend.ts');
        }
        // Plan-011: ssr.external is now an npm-only allowlist. Workspace
        // packages MUST go through Vite's SSR loader so they share the
        // same module instance as everything else in the SSR call graph
        // (otherwise we get duplicate React contexts, duplicate Linked
        // package registrations, etc).
        //
        // Pre-check whether the specifier actually resolves before
        // calling ssrLoadModule — many packages have no `/backend`
        // export, and ssrLoadModule logs a "Failed to load url" error
        // INTERNALLY before throwing, which spams stdout even when the
        // surrounding catch handles it. pluginContainer.resolveId is
        // quiet: it returns null when no plugin can resolve the id.
        try {
          const resolved = await vite.pluginContainer?.resolveId?.(specifier);
          if (!resolved) {
            // Synthesise the same error shape the catch expects so the
            // "no backend export, that's fine" branch fires.
            const err: any = new Error(
              `Failed to load url ${specifier} (resolved id: ${specifier}). Does the file exist?`,
            );
            throw err;
          }
        } catch (e: any) {
          // If the pre-check itself errored (e.g. plugin threw on a
          // pkg name it doesn't know), let the call below surface the
          // real error path.
          if (!e?.message?.includes('Failed to load url')) {
            // fall through to ssrLoadModule which will throw + log
          } else {
            throw e;
          }
        }
        return await vite.ssrLoadModule(specifier);
      }
      // No-vite path (e.g. production runtime). Fall back to Node's
      // resolver. The dynamic specifier is intentional.
      return await import(/* @vite-ignore */ specifier);
    };
    await loadModule(backendIndexFilePath)
      .then((backendProviderExports) => {
        //instantiate the exported provider classes and add them to the right place
        Object.keys(backendProviderExports).forEach((key) => {
          let providerClass = backendProviderExports[key];
          //always send an instance of the express server
          //TODO: do not create an instance, just save the class and instantiate it when needed
          let provider = new providerClass(this.server, this);
          if (provider instanceof ShapeProvider) {
            shapeProviders.push(provider);
            if (!Object.getOwnPropertyNames(provider).includes('shape')) {
              console.warn(
                chalk.red(`${
                  Object.getPrototypeOf(provider).constructor.name
                } in package ${pkg}
               is not properly linked to a shape. Use public shape = SomeShape.`)
              );
            }
          } else {
            if (genericBackendProvider) {
              console.warn(
                `Package ${pkg} exports two generic backend providers. Only one will work`
              );
            } else {
              genericBackendProvider = provider;
            }
          }
        });
      })
      .catch((e) => {
        // Recognize "no /backend export" failures across two loader
        // shapes:
        //   Node's import()             → ERR_MODULE_NOT_FOUND + "Cannot find module 'X/backend'"
        //   Vite's ssrLoadModule()      → "Failed to load url X/backend"
        //   package `exports` without a ./backend entry (Node + Vite)
        //                               → 'Missing "./backend" specifier in "X" package'
        // In either case, missing /backend on a package that doesn't
        // ship a backend is expected; loud-error only on REAL load
        // failures (syntax error inside an existing backend.ts, etc).
        const nodeMatch = e.message.match(/module \'([^\']+)'/);
        const viteMatch = e.message.match(/Failed to load url ([^\s]+)/);
        const matchedSpec = nodeMatch?.[1] ?? viteMatch?.[1];
        const notExported = /Missing "\.\/backend" specifier in "[^"]+" package/.test(
          e.message
        );
        let providerNotFound =
          notExported ||
          (!!matchedSpec &&
            matchedSpec.includes('/backend') &&
            ((e.code === 'ERR_MODULE_NOT_FOUND' &&
              e.message.indexOf(`Cannot find module`) !== -1) ||
              e.message.indexOf('Failed to load url') !== -1));
        if (providerNotFound) {
          // console.warn('Error loading ' + providerPath + ': ' + e.stack);
          if (warnIfNotFound) {
            console.warn(
              chalk.magenta(`Could not find backend file of package ${pkg}. 
        Check:\n
          - Make sure backend.ts exists and is included in tsconfig.json\n
          - Make sure the package name in src/package.ts matches the package name in package.json`)
            );
          }
        } else {
          console.warn(
            chalk.red(
              `Could not load backend file of module '${pkg}' from ${process.cwd()}:\n`
            ),
            e.stack
          );
        }
        genericBackendProvider = null;
      });
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
          chalk.yellow(`[linked] ${label} dispose failed: ${err.message}`)
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
          chalk.yellow(
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
            chalk.yellow(
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
          chalk.red('Invalid server call request: ' + request.originalUrl)
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
      await this.indexPackageBackendProviders(pkg, true);
    }

    let packageShapeProviders = this.shapeProviders.get(pkg);

    let findProviderForShape = (nodeShapeId: string) => {
      return packageShapeProviders.find((provider) => {
        //access the static shape (which is a linkedShape() / Shape class)
        //then access the SHACL NodeShape of that shape class, and its id
        return (
          provider instanceof ShapeProvider &&
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
      console.warn(chalk.red(logMessage || message));
    }
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
    // 2. Walk moduleGraph for CSS entries, load each via `?inline`
    //    (Vite returns raw CSS string as default export).
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

    let ssrCss = '';
    if (vite?.moduleGraph?.idToModuleMap) {
      const cssChunks: string[] = [];
      const seen = new Set<string>();
      // Walk the moduleGraph for CSS modules pulled in by app/pages.
      // Note: Tailwind v4 `@theme` directives in app theme CSS files are
      // NOT processed at SSR collection time — the @tailwindcss/vite
      // plugin expands them at production build only. In dev mode, the
      // theme variables (—color-primary-*, etc.) are injected by Vite's
      // runtime AFTER client hydration, which causes a brief flash of
      // unthemed content (logos render black until ~hydration+200ms).
      // Production (vite build) is unaffected — the static main.css
      // contains expanded :root variables.
      for (const [id] of vite.moduleGraph.idToModuleMap as Map<
        string,
        any
      >) {
        if (seen.has(id)) continue;
        if (!/\.(module\.)?css(\?(?!.*inline)[^?]*)?$/.test(id)) continue;
        seen.add(id);
        try {
          const inlineUrl = id + (id.includes('?') ? '&' : '?') + 'inline';
          const cssModule = await vite.ssrLoadModule(inlineUrl);
          if (typeof cssModule?.default === 'string') {
            cssChunks.push(cssModule.default);
          }
        } catch {/* skip */}
      }
      ssrCss = cssChunks.join('\n');
    }
    (this.assets as any)['__viteSsrCss'] = ssrCss;

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

    let manifest = this.latestManifest || this.assets.manifest || {};
    let preloadScripts: string[] = [];
    let preloadStyles: string[] = [];
    let matchedRouteKey: string | null = null;
    // Plan-010 Vite dev mode: skip preload resolution entirely. Vite
    // handles dynamic import() at runtime — there are no pre-built
    // chunks to preload, and the webpack-shape fallback would pick up
    // stale bundles on disk (public/bundles/*.bundle.js from a prior
    // webpack build) and link them, breaking hydration.
    const usingViteDev =
      !!(this.config.server as any)?.vite && !this.latestManifest;

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
        for (const [key, route] of Object.entries(ROUTES)) {
          if (!route?.path) continue;
          const pathPattern = route.path
            .replace(/:\w+\??/g, '([^/]+)')
            .replace(/\*/g, '.*');
          const regex = new RegExp('^' + pathPattern + '$');
          if (regex.test(req.path)) {
            matchedRoute = route;
            matchedRouteKey = key;
            break;
          }
        }

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

    stream = renderToPipeableStream(
      <React.StrictMode>
        <StaticRouter location={req.url}>
          <AppContextProvider
            assets={this.assets}
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
        // Bootstrap scripts:
        // - Vite dev mode: use bootstrapModules so the browser loads them
        //   as ES modules. Vite middleware intercepts /src/index.tsx and
        //   transforms+serves it; /@vite/client provides the HMR client.
        //   @vitejs/plugin-react requires a "preamble" inline script
        //   defining $RefreshReg$/$RefreshSig$ — without it, the first
        //   React module throws "can't detect preamble" and hydration
        //   blows up. Inline via bootstrapScriptContent.
        // - Production, Vite build: bootstrapModules with the hashed main.js
        //   from the Vite manifest. Vite always emits the entry as an ES
        //   module, and React renders bootstrapScripts as a plain
        //   `<script src async>` — the browser then refuses the file with
        //   "Cannot use import statement outside a module" and the app never
        //   boots. bootstrapModules is the same tag with type="module".
        // - Production, legacy webpack build: bootstrapScripts, because that
        //   bundle is a classic script and a module tag would break it.
        ...((this.config.server as any)?.vite
          ? {
              bootstrapScriptContent: `
                import("/@vite/client");
                import("/@react-refresh").then(RefreshRuntime => {
                  RefreshRuntime.injectIntoGlobalHook(window);
                  window.$RefreshReg$ = () => {};
                  window.$RefreshSig$ = () => (type) => type;
                  window.__vite_plugin_react_preamble_installed__ = true;
                  return import("/src/index.tsx");
                });
              `,
            }
          : this.mainEntryIsModule
            ? {bootstrapModules: [this.assets['main.js']]}
            : {bootstrapScripts: [this.assets['main.js']]}),
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
    // initialise the request for all providers, do it synchroniously, one after the other
    let p = Promise.resolve();
    [...this.genericProviders.values()]
      .filter(Boolean)
      .forEach((backendProvider) => {
        p = p
          .then(() => {
            return backendProvider.initRequest(request, response);
          })
          .catch((err) => {
            console.warn(
              `Error during initRequest for provider ${
                Object.getPrototypeOf(backendProvider).constructor.name
              }: `,
              err
            );
          });
      });

    return p;
  }

  async getRequestData(
    request,
    response
  ): Promise<{ requestLD: string; requestObject: string }> {
    // Phase 1: providers return plain JSON data via supplyDataForRequest.
    // requestLD is kept as empty string for now — SSR data seeding will be
    // reworked in Phase 2/3 to inject query results instead of graph data.
    let requestData: Record<string, any> = {};
    await Promise.all(
      [...this.genericProviders.values()].map((backendProvider) => {
        if (backendProvider) {
          return Promise.resolve(
            backendProvider.supplyDataForRequest(request, response, requestData)
          ).catch((err) => {
            console.warn(
              `Error requesting page-request data from ${
                Object.getPrototypeOf(backendProvider).constructor.name
              }: `,
              err
            );
          });
        }
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
      await this.indexPackageBackendProviders(pkg, true);
    }

    //retrieve the indexed provider class and create a new instance for this request
    let genericBackendProvider = this.genericProviders.get(pkg);

    let result;
    if (!genericBackendProvider) {
      console.warn(
        `${chalk.magenta(
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
