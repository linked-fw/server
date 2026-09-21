import { describe, expect, it } from '@jest/globals';

import { bundleAssetURL } from '../utils/releaseManifest.js';
import {
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
