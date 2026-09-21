import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { bundleAssetURL } from '../utils/releaseManifest.js';
import {
  resetUnresolvedChunkWarnings,
  resolveRouteAssets,
  resolveRouteScript,
  resolveRouteStyles,
} from '../utils/routeAssets.js';

const RELEASE_ROOT = 'https://cdn.example.test/releases/1.5.0-2a77e89f';
/** Where the bundle lives on that release — Vite's `base` for the build. */
const BUNDLE_BASE = `${RELEASE_ROOT}/public/bundles`;

/** A Vite manifest as `vite build` writes it for two lazy route pages. */
const viteManifest = {
  'src/index.tsx': {
    file: 'assets/main-abc123.js',
    src: 'src/index.tsx',
    isEntry: true,
    css: ['assets/main-abc123.css'],
  },
  'src/pages/Home.tsx': {
    file: 'assets/Home-def456.js',
    src: 'src/pages/Home.tsx',
    css: ['assets/Home-def456.css'],
  },
  'src/pages/nested/Profile.tsx': {
    file: 'assets/nested/Profile-ghi789.js',
    src: 'src/pages/nested/Profile.tsx',
    css: ['assets/nested/Profile-ghi789.css', 'assets/shared-jkl012.css'],
  },
};

/** The legacy webpack manifest shape: output name → bare URL string. */
const webpackManifest = {
  'Home.js': '/bundles/Home.bundle.js',
  'Home.css': '/bundles/Home.css',
};

describe('bundleAssetURL', () => {
  it('joins a bundle-relative path onto the release base', () => {
    expect(bundleAssetURL(RELEASE_ROOT, 'assets/Home-def456.js')).toBe(
      `${BUNDLE_BASE}/assets/Home-def456.js`,
    );
  });

  it('keeps an empty base origin-relative', () => {
    expect(bundleAssetURL('', 'assets/Home-def456.js')).toBe(
      '/public/bundles/assets/Home-def456.js',
    );
  });

  it('never doubles the separator for a leading slash or trailing base slash', () => {
    expect(bundleAssetURL(`${RELEASE_ROOT}/`, '/assets/Home-def456.js')).toBe(
      `${BUNDLE_BASE}/assets/Home-def456.js`,
    );
  });
});

describe('route preload URLs on a release base', () => {
  it('serves route scripts from the release the build was published as', () => {
    expect(resolveRouteScript(viteManifest, 'Home', RELEASE_ROOT)).toBe(
      `${BUNDLE_BASE}/assets/Home-def456.js`,
    );
  });

  it('resolves CSS entries the same way as JS', () => {
    expect(resolveRouteStyles(viteManifest, 'Home', RELEASE_ROOT)).toEqual([
      `${BUNDLE_BASE}/assets/Home-def456.css`,
    ]);
  });

  it('gets the join right for a nested chunk path', () => {
    const { scripts, styles } = resolveRouteAssets(
      viteManifest,
      ['Profile'],
      RELEASE_ROOT,
    );
    expect(scripts).toEqual([`${BUNDLE_BASE}/assets/nested/Profile-ghi789.js`]);
    expect(styles).toEqual([
      `${BUNDLE_BASE}/assets/nested/Profile-ghi789.css`,
      `${BUNDLE_BASE}/assets/shared-jkl012.css`,
    ]);
    // No `//` anywhere but after the scheme — a doubled slash is a 404 on a
    // plain static store.
    for (const url of [...scripts, ...styles]) {
      expect(url.replace(/^https:\/\//, '')).not.toContain('//');
    }
  });

  it('puts route assets on the same base as the entry tags', () => {
    const { scripts } = resolveRouteAssets(viteManifest, ['Home'], RELEASE_ROOT);
    const entry = bundleAssetURL(RELEASE_ROOT, viteManifest['src/index.tsx'].file);
    // One page, one origin: the route chunk and main.js share a prefix.
    expect(scripts[0].startsWith(BUNDLE_BASE)).toBe(true);
    expect(entry.startsWith(BUNDLE_BASE)).toBe(true);
  });
});

describe('route preload URLs on an empty base', () => {
  it('stays origin-relative under the directory the server mounts', () => {
    const { scripts, styles } = resolveRouteAssets(viteManifest, ['Home'], '');
    // `express.static('./public')` is mounted at `/public`, so this is where
    // an app serving its own bundles actually answers for them.
    expect(scripts).toEqual(['/public/bundles/assets/Home-def456.js']);
    expect(styles).toEqual(['/public/bundles/assets/Home-def456.css']);
    for (const url of [...scripts, ...styles]) {
      expect(url.startsWith('/public/bundles/')).toBe(true);
    }
  });

  it('never emits an absolute URL when no base is configured', () => {
    const { scripts, styles } = resolveRouteAssets(
      viteManifest,
      ['Home', 'Profile'],
      '',
    );
    for (const url of [...scripts, ...styles]) {
      expect(url).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
    }
  });
});

describe('manifest shapes and misses', () => {
  it('still reads the legacy webpack manifest, on the same base', () => {
    expect(resolveRouteScript(webpackManifest, 'Home', RELEASE_ROOT)).toBe(
      `${BUNDLE_BASE}/Home.bundle.js`,
    );
    expect(resolveRouteStyles(webpackManifest, 'Home', RELEASE_ROOT)).toEqual([
      `${BUNDLE_BASE}/Home.css`,
    ]);
  });

  it('leaves a webpack entry that already names its own host alone', () => {
    expect(
      resolveRouteScript(
        { 'Home.js': 'https://other.example.test/Home.js' },
        'Home',
        RELEASE_ROOT,
      ),
    ).toBe('https://other.example.test/Home.js');
  });

  it('matches a Vite entry by the tail of its source path', () => {
    expect(resolveRouteScript(viteManifest, 'Profile', '')).toBe(
      '/public/bundles/assets/nested/Profile-ghi789.js',
    );
  });

  it('skips a chunk the manifest does not know', () => {
    const { scripts, styles } = resolveRouteAssets(
      viteManifest,
      ['Missing', 'Home'],
      RELEASE_ROOT,
    );
    expect(scripts).toEqual([`${BUNDLE_BASE}/assets/Home-def456.js`]);
    expect(styles).toEqual([`${BUNDLE_BASE}/assets/Home-def456.css`]);
  });

  it('returns nothing for an empty manifest', () => {
    expect(resolveRouteAssets({}, ['Home'], RELEASE_ROOT)).toEqual({
      scripts: [],
      styles: [],
    });
  });
});

describe('preload chunk names that do not match the manifest casing', () => {
  beforeEach(() => {
    resetUnresolvedChunkWarnings();
  });

  it('resolves a webpack-era lowercase name against the Vite manifest', () => {
    // `preloadChunks: ['home']` is what the old app template shipped.
    const { scripts, styles } = resolveRouteAssets(
      viteManifest,
      ['home'],
      RELEASE_ROOT,
    );
    expect(scripts).toEqual([`${BUNDLE_BASE}/assets/Home-def456.js`]);
    expect(styles).toEqual([`${BUNDLE_BASE}/assets/Home-def456.css`]);
  });

  it('finds a nested page by a lowercase name too', () => {
    expect(resolveRouteScript(viteManifest, 'profile', '')).toBe(
      '/public/bundles/assets/nested/Profile-ghi789.js',
    );
  });

  it('does not let the fallback match a different page ending in the name', () => {
    // `Home` must not be answered by `MyHome.tsx` — the fallback is anchored
    // on the path separator.
    const manifest = {
      'src/pages/MyHome.tsx': {
        file: 'assets/MyHome-xyz.js',
        src: 'src/pages/MyHome.tsx',
      },
    };
    expect(resolveRouteScript(manifest, 'home', RELEASE_ROOT)).toBeNull();
  });

  it('prefers the exact match over the case-insensitive one', () => {
    const manifest = {
      'src/pages/home.tsx': {
        file: 'assets/lowercase-000.js',
        src: 'src/pages/home.tsx',
      },
      'src/pages/Home.tsx': {
        file: 'assets/Home-def456.js',
        src: 'src/pages/Home.tsx',
      },
    };
    // Exact source-path lookup wins even though the lowercase key is first.
    expect(resolveRouteScript(manifest, 'Home', RELEASE_ROOT)).toBe(
      `${BUNDLE_BASE}/assets/Home-def456.js`,
    );
    expect(resolveRouteScript(manifest, 'home', RELEASE_ROOT)).toBe(
      `${BUNDLE_BASE}/assets/lowercase-000.js`,
    );
  });
});

describe('warning about an unresolved preload chunk', () => {
  let warn: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    resetUnresolvedChunkWarnings();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('warns once per name across repeated calls, and still returns no URLs', () => {
    for (let i = 0; i < 3; i++) {
      const { scripts, styles } = resolveRouteAssets(
        viteManifest,
        ['NoSuchPage'],
        RELEASE_ROOT,
      );
      expect(scripts).toEqual([]);
      expect(styles).toEqual([]);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('NoSuchPage');
    expect(message).toContain('manifest');
  });

  it('does not warn about a chunk the manifest resolves', () => {
    resolveRouteAssets(viteManifest, ['Home', 'home'], RELEASE_ROOT);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns separately for each distinct unresolved name', () => {
    resolveRouteAssets(viteManifest, ['Ghost', 'Phantom'], RELEASE_ROOT);
    resolveRouteAssets(viteManifest, ['Ghost', 'Phantom'], RELEASE_ROOT);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
