import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  RELEASE_MANIFEST_PATH,
  readReleaseManifest,
  releaseStaticAccessURL,
  resolveStaticAccessURL,
  staticAssetURL,
} from '../utils/releaseManifest.js';

const ACCESS_URL = 'https://cdn.example.test';
const RELEASE_PREFIX = 'releases/1.5.0-2a77e89f';
const RELEASE_ROOT = `${ACCESS_URL}/${RELEASE_PREFIX}`;
const BASE_URL = `${RELEASE_ROOT}/public/bundles/`;

/** A manifest as `@_linked/cli` writes it for a web release. */
const webManifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  appName: 'demo-app',
  appVersion: '1.5.0',
  releaseId: '1.5.0-2a77e89f',
  target: 'web',
  publishable: true,
  builtAt: '2026-09-01T00:00:00.000Z',
  environmentNames: ['production'],
  destination: {
    accessURL: ACCESS_URL,
    releasePrefix: RELEASE_PREFIX,
    baseURL: BASE_URL,
  },
  files: [],
  ...overrides,
});

let tmpRoot: string;
// Collected instead of printed: a malformed manifest must warn, and the tests
// assert that it did rather than littering the test output.
const warnings: string[] = [];
const warn = (message: string) => {
  warnings.push(message);
};

/** Write a manifest into a fresh app root and return that root. */
const appRootWithManifest = async (contents: string | null): Promise<string> => {
  const appRoot = await fs.mkdtemp(path.join(tmpRoot, 'app-'));
  if (contents !== null) {
    const manifestPath = path.join(appRoot, RELEASE_MANIFEST_PATH);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, contents);
  }
  return appRoot;
};

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'release-manifest-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('readReleaseManifest', () => {
  it('returns null when the app has no release manifest', async () => {
    const appRoot = await appRootWithManifest(null);
    expect(readReleaseManifest(appRoot, warn)).toBeNull();
  });

  it('reads a manifest written by the CLI', async () => {
    const appRoot = await appRootWithManifest(JSON.stringify(webManifest()));
    expect(readReleaseManifest(appRoot, warn)?.destination?.baseURL).toBe(BASE_URL);
  });

  it('ignores a manifest that is not valid JSON, and warns', async () => {
    warnings.length = 0;
    const appRoot = await appRootWithManifest('{"schemaVersion": 1,');
    expect(readReleaseManifest(appRoot, warn)).toBeNull();
    expect(warnings.join('\n')).toContain('unreadable release manifest');
  });

  it('ignores a manifest that is valid JSON but not an object', async () => {
    warnings.length = 0;
    const appRoot = await appRootWithManifest('["not", "a", "manifest"]');
    expect(readReleaseManifest(appRoot, warn)).toBeNull();
    expect(warnings.join('\n')).toContain('expected a JSON object');
  });

  it('ignores an unknown schemaVersion rather than guessing at its shape', async () => {
    warnings.length = 0;
    const appRoot = await appRootWithManifest(
      JSON.stringify(webManifest({ schemaVersion: 99 })),
    );
    expect(readReleaseManifest(appRoot, warn)).toBeNull();
    expect(warnings.join('\n')).toContain('unsupported schemaVersion');
  });
});

describe('releaseStaticAccessURL', () => {
  it('derives the release root from destination.baseURL', () => {
    expect(releaseStaticAccessURL(webManifest())).toBe(RELEASE_ROOT);
  });

  it('tolerates a baseURL without a trailing slash', () => {
    const manifest = webManifest({
      destination: {
        accessURL: ACCESS_URL,
        releasePrefix: RELEASE_PREFIX,
        baseURL: `${RELEASE_ROOT}/public/bundles`,
      },
    });
    expect(releaseStaticAccessURL(manifest)).toBe(RELEASE_ROOT);
  });

  it('falls back to accessURL + releasePrefix when baseURL is missing', () => {
    const manifest = webManifest({
      destination: { accessURL: `${ACCESS_URL}/`, releasePrefix: RELEASE_PREFIX },
    });
    expect(releaseStaticAccessURL(manifest)).toBe(RELEASE_ROOT);
  });

  it('ignores a relative baseURL and uses the destination instead', () => {
    const manifest = webManifest({
      destination: {
        accessURL: ACCESS_URL,
        releasePrefix: RELEASE_PREFIX,
        baseURL: '/public/bundles/',
      },
    });
    expect(releaseStaticAccessURL(manifest)).toBe(RELEASE_ROOT);
  });

  it('returns nothing for a Capacitor manifest, which has no destination', () => {
    const manifest = webManifest({
      target: 'capacitor',
      publishable: false,
      destination: { accessURL: '', releasePrefix: RELEASE_PREFIX, baseURL: '' },
    });
    expect(releaseStaticAccessURL(manifest)).toBe('');
  });

  it('returns nothing when there is no manifest at all', () => {
    expect(releaseStaticAccessURL(null)).toBe('');
  });
});

describe('resolveStaticAccessURL precedence', () => {
  it('uses a relative base in development, even with a manifest present', async () => {
    const appRoot = await appRootWithManifest(JSON.stringify(webManifest()));
    const resolved = resolveStaticAccessURL({
      isDevAssets: true,
      appRoot,
      env: { STATIC_ACCESS_URL: 'https://ignored.example.test' },
      fileStoreAccessURL: 'https://uploads.example.test',
      warn,
    });
    expect(resolved).toBe('');
    // Vite serves the assets itself, so the tags stay origin-relative.
    expect(staticAssetURL(resolved, '/bundles/main-abc123.js')).toBe(
      '/public/bundles/main-abc123.js',
    );
  });

  it('lets an explicit STATIC_ACCESS_URL win over the manifest', async () => {
    const appRoot = await appRootWithManifest(JSON.stringify(webManifest()));
    expect(
      resolveStaticAccessURL({
        appRoot,
        env: { STATIC_ACCESS_URL: 'https://pinned.example.test/releases/old/' },
        fileStoreAccessURL: 'https://uploads.example.test',
        warn,
      }),
    ).toBe('https://pinned.example.test/releases/old');
  });

  it('uses the manifest when STATIC_ACCESS_URL is unset', async () => {
    const appRoot = await appRootWithManifest(JSON.stringify(webManifest()));
    expect(
      resolveStaticAccessURL({
        appRoot,
        env: {},
        fileStoreAccessURL: 'https://uploads.example.test',
        warn,
      }),
    ).toBe(RELEASE_ROOT);
  });

  it('treats an empty STATIC_ACCESS_URL as unset', async () => {
    const appRoot = await appRootWithManifest(JSON.stringify(webManifest()));
    expect(
      resolveStaticAccessURL({ appRoot, env: { STATIC_ACCESS_URL: '  ' }, warn }),
    ).toBe(RELEASE_ROOT);
  });

  it('falls back to the file store access URL when there is no manifest', async () => {
    const appRoot = await appRootWithManifest(null);
    expect(
      resolveStaticAccessURL({
        appRoot,
        env: {},
        fileStoreAccessURL: 'https://uploads.example.test/',
        warn,
      }),
    ).toBe('https://uploads.example.test');
  });

  it('falls back to the file store access URL when the manifest is broken', async () => {
    const appRoot = await appRootWithManifest('not json at all');
    expect(
      resolveStaticAccessURL({
        appRoot,
        env: {},
        fileStoreAccessURL: 'https://uploads.example.test',
        warn,
      }),
    ).toBe('https://uploads.example.test');
  });

  it('falls back to the file store access URL for a Capacitor manifest', async () => {
    const appRoot = await appRootWithManifest(
      JSON.stringify(
        webManifest({
          target: 'capacitor',
          publishable: false,
          destination: { accessURL: '', releasePrefix: RELEASE_PREFIX, baseURL: '' },
        }),
      ),
    );
    expect(
      resolveStaticAccessURL({
        appRoot,
        env: {},
        fileStoreAccessURL: 'https://uploads.example.test',
        warn,
      }),
    ).toBe('https://uploads.example.test');
  });

  it('resolves to an empty base when nothing is configured', async () => {
    const appRoot = await appRootWithManifest(null);
    expect(resolveStaticAccessURL({ appRoot, env: {}, warn })).toBe('');
  });
});

describe('rendered asset URLs', () => {
  it('builds entry tag URLs under the published release prefix', async () => {
    const appRoot = await appRootWithManifest(JSON.stringify(webManifest()));
    const base = resolveStaticAccessURL({ appRoot, env: {}, warn });

    // These are the exact href/src values the SSR'd <link> and bootstrap
    // script tags carry, and they have to match the URLs the bundle itself
    // was built with (Vite's `base` === destination.baseURL).
    expect(staticAssetURL(base, '/bundles/main-abc123.js')).toBe(
      `${BASE_URL}main-abc123.js`,
    );
    expect(staticAssetURL(base, '/bundles/main-abc123.css')).toBe(
      `${BASE_URL}main-abc123.css`,
    );
  });

  it('is byte-for-byte what STATIC_ACCESS_URL produced before', async () => {
    const appRoot = await appRootWithManifest(JSON.stringify(webManifest()));
    const fromEnv = resolveStaticAccessURL({
      appRoot,
      env: { STATIC_ACCESS_URL: RELEASE_ROOT },
      warn,
    });
    const fromManifest = resolveStaticAccessURL({ appRoot, env: {}, warn });
    expect(staticAssetURL(fromManifest, '/bundles/main.css')).toBe(
      staticAssetURL(fromEnv, '/bundles/main.css'),
    );
  });
});
