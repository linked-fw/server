import { afterEach, describe, expect, it } from '@jest/globals';
import { AskBuilder } from '@_linked/core/queries/AskBuilder';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { Server } from '@_linked/server-utils/utils/Server';
import { RemoteDataset } from '../shapes/quadstores/RemoteDataset.js';
import LincdServerBackendProvider from '../backend.js';
import { packageName } from '../package.js';
import { readQueryOf } from './read-double.js';

// An ask crosses the wire to `readQuery` like the other reads: the client store ships `toJSON()`
// through Server.call, and this package's generic backend provider tells its kind from the body,
// rehydrates it with `fromJSON()` and answers through LinkedStorage.

const IRI = 'http://example.org/node-1';
const originalCall = Server.call;

afterEach(() => {
  (Server as any).call = originalCall;
});

describe('RemoteDataset.readQuery of an ask', () => {
  it('forwards the ask as DSL-JSON via Server.call', async () => {
    const calls: any[] = [];
    (Server as any).call = async (...args: any[]) => {
      calls.push(args);
      return true;
    };
    const store = new RemoteDataset({ id: 'http://example.org/store' });
    const query = AskBuilder.forNode(IRI);

    await expect(store.readQuery(query)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    // Addressed by PACKAGE NAME, not by the store instance. Sending the store is
    // what forced this class to be a Shape; the backend never read it.
    expect(calls[0][0]).toBe(packageName);
    expect(calls[0][1]).toEqual({ method: 'readQuery', rejectOnError: true });
    expect(calls[0][2]).toEqual(query.toJSON());
  });
});

describe('LincdServerBackendProvider.readQuery of an ask', () => {
  it('rehydrates the JSON and answers through LinkedStorage', async () => {
    const received: any[] = [];
    const dataset: any = {
      init: async () => {},
      supports: ['ask'],
      readQuery: readQueryOf({
        select: async () => [],
        ask: async (q) => {
          received.push(q);
          return true;
        },
      }),
      createQuery: async () => ({}),
      updateQuery: async () => ({}),
      deleteQuery: async () => ({}),
    };
    LinkedStorage.setDefaultDataset(dataset);
    const json = AskBuilder.forNode(IRI).toJSON();
    const provider = Object.create(LincdServerBackendProvider.prototype);

    await expect(provider.readQuery(json)).resolves.toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].__queryKind).toBe('ask');
    expect(received[0].toJSON()).toEqual(json);
  });
});
