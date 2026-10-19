import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { isLinkedError } from '@_linked/core/utils/linkedError';
import { getRawQueriesMode, setRawQueriesMode } from '../utils/rawQueries.js';
import { getRpcExposureMode, setRpcExposureMode } from '../utils/rpcExposure.js';
import { resolveQueryCatalog, setQueryCatalogResolver } from '../utils/queryPlane.js';
import {
  RemoteDatasetError,
  RemoteDatasetUnauthorizedError,
  RemoteDatasetUnreachableError,
} from '../shapes/quadstores/RemoteDataset.js';
import { FatalStartupError } from '../utils/fatalError.js';

/**
 * A second, independently evaluated copy of a module and everything it imports (core
 * included), as a second loader in one process would produce.
 */
async function secondCopy<T>(load: () => Promise<T>): Promise<T> {
  let copy: T | undefined;
  await jest.isolateModulesAsync(async () => {
    copy = await load();
  });
  if (!copy) throw new Error('second copy did not load');
  return copy;
}

describe('a second copy of @_linked/server shares its configuration', () => {
  afterEach(() => {
    setRawQueriesMode(undefined);
    setRpcExposureMode(undefined);
    setQueryCatalogResolver(undefined);
  });

  it('server.rawQueries set on one copy is the mode on the other', async () => {
    const other = await secondCopy(() => import('../utils/rawQueries.js'));
    expect(other.setRawQueriesMode).not.toBe(setRawQueriesMode);
    setRawQueriesMode('off');
    expect(other.getRawQueriesMode()).toBe('off');
    other.setRawQueriesMode('session');
    expect(getRawQueriesMode()).toBe('session');
  });

  it('server.rpcExposure set on one copy is the mode on the other', async () => {
    const other = await secondCopy(() => import('../utils/rpcExposure.js'));
    setRpcExposureMode('enforce');
    expect(other.getRpcExposureMode()).toBe('enforce');
  });

  it("the host's query catalog resolver set on one copy answers on the other", async () => {
    const other = await secondCopy(() => import('../utils/queryPlane.js'));
    const catalog = { id: 'two-copies' } as any;
    setQueryCatalogResolver(() => catalog);
    await expect(other.resolveQueryCatalog({ shape: 'x' })).resolves.toBe(catalog);
    other.setQueryCatalogResolver(undefined);
    await expect(resolveQueryCatalog({ shape: 'x' })).resolves.toBeUndefined();
  });
});

describe("errors thrown by another copy of @_linked/server", () => {
  it('RemoteDataset errors match by brand where instanceof does not', async () => {
    const other = await secondCopy(() => import('../shapes/quadstores/RemoteDataset.js'));
    const err = new other.RemoteDatasetUnreachableError('down', 'http://x', 0);
    expect(err).not.toBeInstanceOf(RemoteDatasetUnreachableError);
    expect(isLinkedError(err, RemoteDatasetUnreachableError)).toBe(true);
    expect(isLinkedError(err, RemoteDatasetError)).toBe(true);
    expect(isLinkedError(err, RemoteDatasetUnauthorizedError)).toBe(false);
    expect(
      isLinkedError(new other.RemoteDatasetUnauthorizedError('no', 'http://x', 401), RemoteDatasetError)
    ).toBe(true);
  });

  it('FatalStartupError matches by brand', async () => {
    const other = await secondCopy(() => import('../utils/fatalError.js'));
    const err = new other.FatalStartupError('JWT_SECRET is not set');
    expect(err).not.toBeInstanceOf(FatalStartupError);
    expect(isLinkedError(err, FatalStartupError)).toBe(true);
  });
});

describe('process-wide setup runs once per process', () => {
  it('a second copy of LinkedServer does not wrap fetch again or add process listeners', async () => {
    await import('../shapes/LinkedServer.js');
    const fetchAfterFirst = globalThis.fetch;
    const listeners = process.listenerCount('uncaughtException');
    const other = await secondCopy(() => import('../shapes/LinkedServer.js'));
    expect(other.LinkedServer).toBeDefined();
    expect(globalThis.fetch).toBe(fetchAfterFirst);
    expect(process.listenerCount('uncaughtException')).toBe(listeners);
  });
});
