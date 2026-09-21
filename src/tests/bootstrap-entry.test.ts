import { describe, expect, it } from '@jest/globals';
import {
  resolveBootstrapEntry,
  resolveViteMainEntry,
  VITE_DEV_BOOTSTRAP_CONTENT,
} from '../utils/bootstrapEntry.js';

/** A Vite build manifest: entries are objects keyed by source path. */
const VITE_MANIFEST = {
  'src/index.tsx': {
    file: 'assets/main-abc123.js',
    src: 'src/index.tsx',
    isEntry: true,
    css: ['assets/main-abc123.css'],
  },
  'src/pages/Home.tsx': {
    file: 'assets/Home-def456.js',
    src: 'src/pages/Home.tsx',
  },
};

/** A legacy webpack manifest: output names mapped to bare URL strings. */
const WEBPACK_MANIFEST = {
  'main.js': '/bundles/main.bundle.js',
  'main.css': '/bundles/main.css',
  'Home.js': '/bundles/Home.bundle.js',
};

describe('resolveViteMainEntry', () => {
  it('finds the entry keyed by src/index.tsx', () => {
    expect(resolveViteMainEntry(VITE_MANIFEST)?.file).toBe(
      'assets/main-abc123.js',
    );
  });

  it('finds the entry keyed by src/index.ts', () => {
    const manifest = {
      'src/index.ts': { file: 'assets/main-xyz789.js', isEntry: true },
    };
    expect(resolveViteMainEntry(manifest)?.file).toBe('assets/main-xyz789.js');
  });

  it('falls back to the isEntry chunk when the entry sits elsewhere', () => {
    const manifest = {
      'src/pages/Home.tsx': { file: 'assets/Home-def456.js' },
      'app/boot.tsx': { file: 'assets/boot-111222.js', isEntry: true },
    };
    expect(resolveViteMainEntry(manifest)?.file).toBe('assets/boot-111222.js');
  });

  it('returns null for a webpack manifest, whose entries are strings', () => {
    expect(resolveViteMainEntry(WEBPACK_MANIFEST)).toBeNull();
  });

  it('returns null for an empty manifest', () => {
    expect(resolveViteMainEntry({})).toBeNull();
  });
});

describe('resolveBootstrapEntry', () => {
  it('bootstraps a Vite-built entry as an ES module', () => {
    // React renders bootstrapScripts as a plain <script src async>, which the
    // browser refuses for a Vite entry with "Cannot use import statement
    // outside a module".
    const options = resolveBootstrapEntry({
      viteDevServer: false,
      mainEntryIsModule: true,
      mainEntry: 'https://cdn.example.com/r1/bundles/assets/main-abc123.js',
    });
    expect(options).toEqual({
      bootstrapModules: [
        'https://cdn.example.com/r1/bundles/assets/main-abc123.js',
      ],
    });
    expect(options.bootstrapScripts).toBeUndefined();
    expect(options.bootstrapScriptContent).toBeUndefined();
  });

  it('keeps a legacy webpack bundle on bootstrapScripts', () => {
    // A webpack bundle is a classic script; a module tag would break it.
    const options = resolveBootstrapEntry({
      viteDevServer: false,
      mainEntryIsModule: false,
      mainEntry: '/bundles/main.bundle.js?v=2.6.0',
    });
    expect(options).toEqual({
      bootstrapScripts: ['/bundles/main.bundle.js?v=2.6.0'],
    });
    expect(options.bootstrapModules).toBeUndefined();
    expect(options.bootstrapScriptContent).toBeUndefined();
  });

  it('keeps the inline preamble in Vite dev mode', () => {
    const options = resolveBootstrapEntry({
      viteDevServer: true,
      mainEntryIsModule: false,
      mainEntry: '/bundles/main.bundle.js',
    });
    expect(options).toEqual({
      bootstrapScriptContent: VITE_DEV_BOOTSTRAP_CONTENT,
    });
    expect(options.bootstrapModules).toBeUndefined();
    expect(options.bootstrapScripts).toBeUndefined();
  });

  it('serves the dev preamble even once a Vite manifest exists', () => {
    // The dev server transforms and serves the entry itself, so a manifest
    // left over from a `vite build` must not take over the bootstrap.
    const options = resolveBootstrapEntry({
      viteDevServer: true,
      mainEntryIsModule: true,
      mainEntry: '/bundles/assets/main-abc123.js',
    });
    expect(options.bootstrapScriptContent).toBe(VITE_DEV_BOOTSTRAP_CONTENT);
    expect(options.bootstrapModules).toBeUndefined();
  });

  it('installs the react-refresh preamble before importing the entry', () => {
    expect(VITE_DEV_BOOTSTRAP_CONTENT).toContain('/@vite/client');
    expect(VITE_DEV_BOOTSTRAP_CONTENT).toContain(
      '__vite_plugin_react_preamble_installed__',
    );
    expect(VITE_DEV_BOOTSTRAP_CONTENT.indexOf('$RefreshReg$')).toBeLessThan(
      VITE_DEV_BOOTSTRAP_CONTENT.indexOf('import("/src/index.tsx")'),
    );
  });
});

describe('the manifest a build produced decides the tag', () => {
  // End-to-end over the two functions: what start() does when it reads a
  // manifest off disk, minus the filesystem.
  const bootstrapFor = (manifest: Record<string, unknown>) => {
    const mainEntry = resolveViteMainEntry(manifest);
    return resolveBootstrapEntry({
      viteDevServer: false,
      mainEntryIsModule: !!mainEntry?.file,
      mainEntry: mainEntry?.file
        ? `/bundles/${mainEntry.file}`
        : '/bundles/main.bundle.js',
    });
  };

  it('a Vite manifest yields bootstrapModules', () => {
    expect(bootstrapFor(VITE_MANIFEST)).toEqual({
      bootstrapModules: ['/bundles/assets/main-abc123.js'],
    });
  });

  it('a webpack manifest yields bootstrapScripts', () => {
    expect(bootstrapFor(WEBPACK_MANIFEST)).toEqual({
      bootstrapScripts: ['/bundles/main.bundle.js'],
    });
  });
});
