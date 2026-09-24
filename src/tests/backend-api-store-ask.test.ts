import { afterEach, describe, expect, it } from '@jest/globals';
import { AskBuilder } from '@_linked/core/queries/AskBuilder';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { Server } from '@_linked/server-utils/utils/Server';
import { BackendAPIStore } from '../shapes/quadstores/BackendAPIStore.js';
import LincdServerBackendProvider from '../backend.js';
import { packageName } from '../package.js';

// `askQuery` crosses the wire exactly like the other query kinds: the client
// store ships `toJSON()` through Server.call, and this package's generic backend
// provider rehydrates it with `fromJSON()` and answers through LinkedStorage.

const IRI = 'http://example.org/node-1';
const originalCall = Server.call;

afterEach(() => {
  (Server as any).call = originalCall;
});

describe('BackendAPIStore.askQuery', () => {
  it('forwards the ask as DSL-JSON via Server.call', async () => {
    const calls: any[] = [];
    (Server as any).call = async (...args: any[]) => {
      calls.push(args);
      return true;
    };
    const store = new BackendAPIStore({ id: 'http://example.org/store' });
    const query = AskBuilder.forNode(IRI);

    await expect(store.askQuery(query)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    // Addressed by PACKAGE NAME, not by the store instance. Sending the store is
    // what forced this class to be a Shape; the backend never read it.
    expect(calls[0][0]).toBe(packageName);
    expect(calls[0][1]).toEqual({ method: 'askQuery', rejectOnError: true });
    expect(calls[0][2]).toEqual(query.toJSON());
  });
});

describe('LincdServerBackendProvider.askQuery', () => {
  it('rehydrates the JSON and answers through LinkedStorage', async () => {
    const received: any[] = [];
    const dataset: any = {
      init: async () => {},
      selectQuery: async () => [],
      createQuery: async () => ({}),
      updateQuery: async () => ({}),
      deleteQuery: async () => ({}),
      askQuery: async (q: any) => {
        received.push(q);
        return true;
      },
    };
    LinkedStorage.setDefaultDataset(dataset);
    const json = AskBuilder.forNode(IRI).toJSON();
    const provider = Object.create(LincdServerBackendProvider.prototype);

    // One argument now: the old signature led with a store the method ignored.
    await expect(provider.askQuery(json)).resolves.toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].__queryKind).toBe('ask');
    expect(received[0].toJSON()).toEqual(json);
  });
});
