import { describe, expect, it } from '@jest/globals';
import React from 'react';
import {
  resolveRouteComponent,
  ssrCssScope,
  type SsrCssModule,
} from '../utils/ssrCss.js';

const ROOT = '/app';

/**
 * A module graph shaped like CN's dev SSR graph: App statically imports a
 * layout, its global stylesheet and the routes module; the routes module
 * imports every page dynamically; the Tailwind stylesheet lists every scanned
 * source file as a dependency.
 */
const buildGraph = () => {
  const modules = new Map<string, SsrCssModule>();
  const mod = (
    path: string,
    exports: Record<string, unknown> | null = null,
  ): SsrCssModule => {
    const m: SsrCssModule = {
      id: ROOT + path,
      url: path,
      importedModules: new Set(),
      transformResult: { deps: [], dynamicDeps: [] },
      ssrModule: exports,
    };
    modules.set(path, m);
    return m;
  };
  const imports = (from: SsrCssModule, to: SsrCssModule, dynamic = false) => {
    (from.importedModules as Set<SsrCssModule>).add(to);
    (dynamic
      ? from.transformResult!.dynamicDeps!
      : from.transformResult!.deps!
    ).push(to.url);
  };

  const Home = () => null;
  const Signin = () => null;
  const App = () => null;

  const app = mod('/src/App.tsx', { default: App });
  const theme = mod('/src/css/theme.css');
  const themeImport = mod('/src/css/base.css');
  const layout = mod('/src/layout/Layout.tsx');
  const layoutCss = mod('/src/layout/Layout.module.css');
  const routes = mod('/src/routes.tsx');
  const home = mod('/src/pages/Home.tsx', { default: Home });
  const homeCss = mod('/src/pages/Home.module.css');
  const signin = mod('/src/pages/Signin.tsx', { default: Signin });
  const signinCss = mod('/src/pages/Signin.module.css');
  const panel = mod('/src/components/LazyPanel.tsx');
  const panelCss = mod('/src/components/LazyPanel.module.css');

  imports(app, theme);
  imports(theme, themeImport);
  // Tailwind's scanner: every source file becomes a dependency of the sheet.
  imports(theme, home);
  imports(theme, signin);
  imports(theme, panel);
  imports(app, layout);
  imports(layout, layoutCss);
  imports(layout, panel, true);
  imports(panel, panelCss);
  imports(app, routes);
  imports(routes, home, true);
  imports(routes, signin, true);
  imports(home, homeCss);
  imports(signin, signinCss);

  return { modules, App, Home, Signin };
};

const cssIn = (scope: Set<string> | null) =>
  scope ? [...scope].filter((id) => id.endsWith('.css')).sort() : null;

describe('ssrCssScope', () => {
  it("keeps the app's static stylesheets and the matched page's, not other pages'", () => {
    const { modules, App, Signin } = buildGraph();
    expect(
      cssIn(ssrCssScope(modules.values(), { app: App, pages: [Signin] })),
    ).toEqual(
      [
        `${ROOT}/src/css/base.css`,
        `${ROOT}/src/css/theme.css`,
        `${ROOT}/src/layout/Layout.module.css`,
        `${ROOT}/src/pages/Signin.module.css`,
      ].sort(),
    );
  });

  it('keeps only the app stylesheets when no route matched', () => {
    const { modules, App } = buildGraph();
    expect(cssIn(ssrCssScope(modules.values(), { app: App, pages: [] }))).toEqual(
      [
        `${ROOT}/src/css/base.css`,
        `${ROOT}/src/css/theme.css`,
        `${ROOT}/src/layout/Layout.module.css`,
      ].sort(),
    );
  });

  it('keeps every matched page when several routes match the path', () => {
    const { modules, App, Home, Signin } = buildGraph();
    const css = cssIn(
      ssrCssScope(modules.values(), { app: App, pages: [Home, Signin] }),
    );
    expect(css).toContain(`${ROOT}/src/pages/Home.module.css`);
    expect(css).toContain(`${ROOT}/src/pages/Signin.module.css`);
  });

  it('follows a module that is imported both statically and dynamically', () => {
    const { modules, App } = buildGraph();
    const layout = modules.get('/src/layout/Layout.tsx')!;
    layout.transformResult!.deps!.push('/src/components/LazyPanel.tsx');
    expect(
      cssIn(ssrCssScope(modules.values(), { app: App, pages: [] })),
    ).toContain(`${ROOT}/src/components/LazyPanel.module.css`);
  });

  it('gives up (null) when the app module cannot be found', () => {
    const { modules, Signin } = buildGraph();
    expect(
      ssrCssScope(modules.values(), { app: () => null, pages: [Signin] }),
    ).toBeNull();
  });

  it('gives up (null) when a matched page module cannot be found', () => {
    const { modules, App } = buildGraph();
    expect(
      ssrCssScope(modules.values(), { app: App, pages: [() => null] }),
    ).toBeNull();
  });

  it('skips a module whose exports throw when read', () => {
    const { modules, App } = buildGraph();
    const broken = {
      id: `${ROOT}/src/broken.ts`,
      url: '/src/broken.ts',
      importedModules: new Set<SsrCssModule>(),
      ssrModule: Object.defineProperty({}, 'x', {
        enumerable: true,
        get() {
          throw new ReferenceError('not initialised');
        },
      }),
    } as SsrCssModule;
    expect(
      ssrCssScope([broken, ...modules.values()], { app: App, pages: [] }),
    ).not.toBeNull();
  });
});

describe('resolveRouteComponent', () => {
  it('returns a plain component as is', async () => {
    const Page = () => null;
    await expect(resolveRouteComponent({ component: Page })).resolves.toBe(Page);
  });

  it("loads a React.lazy component and returns the module's export", async () => {
    const Page = () => null;
    const LazyPage = React.lazy(async () => ({ default: Page }));
    await expect(resolveRouteComponent({ component: LazyPage })).resolves.toBe(
      Page,
    );
    // and again once React has it cached
    await expect(resolveRouteComponent({ component: LazyPage })).resolves.toBe(
      Page,
    );
  });

  it('returns null for a route without a component', async () => {
    await expect(resolveRouteComponent({})).resolves.toBeNull();
  });

  it('returns undefined (unknown) for a route that renders through a function', async () => {
    await expect(
      resolveRouteComponent({ render: () => null as any }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined (unknown) when a lazy component fails to load', async () => {
    const LazyPage = React.lazy(async () => {
      throw new Error('boom');
    });
    await expect(
      resolveRouteComponent({ component: LazyPage }),
    ).resolves.toBeUndefined();
  });
});
