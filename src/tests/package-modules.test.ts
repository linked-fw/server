import { afterEach, describe, expect, it } from '@jest/globals';
import { loadPackageModule } from '../utils/packageModules.js';

const LOADER = Symbol.for('@_linked/core:importModule');
const globals = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete globals[LOADER];
});

describe('loadPackageModule', () => {
  it("goes through linked start's module loader when one is installed, even with Vite", async () => {
    const loaded: string[] = [];
    const module = { marker: true };
    globals[LOADER] = async (specifier: string) => {
      loaded.push(specifier);
      return module;
    };
    const vite = {
      ssrLoadModule: async () => {
        throw new Error('not through Vite');
      },
    };
    expect(await loadPackageModule('@_linked/example', vite)).toBe(module);
    expect(loaded).toEqual(['@_linked/example']);
  });

  it('without a loader, uses ssrLoadModule bound to Vite when the server runs with one', async () => {
    const loaded: string[] = [];
    const vite = {
      marker: 'vite',
      ssrLoadModule(this: { marker: string }, url: string) {
        loaded.push(`${this.marker}:${url}`);
        return Promise.resolve({ fromVite: true });
      },
    };
    expect(await loadPackageModule('@_linked/example', vite)).toEqual({ fromVite: true });
    expect(loaded).toEqual(['vite:@_linked/example']);
  });

  it("without a loader or Vite, is Node's import()", async () => {
    const mod = (await loadPackageModule('node:path')) as { sep: string };
    expect(typeof mod.sep).toBe('string');
  });

  it('an unresolvable package rejects', async () => {
    await expect(loadPackageModule('@example/not-installed-anywhere')).rejects.toThrow();
  });
});
