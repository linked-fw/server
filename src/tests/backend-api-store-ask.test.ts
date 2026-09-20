import { afterEach, describe, expect, it } from '@jest/globals';
import { AskBuilder } from '@_linked/core/queries/AskBuilder';
import { CountBuilder } from '@_linked/core/queries/CountBuilder';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { Server } from '@_linked/server-utils/utils/Server';
import { BackendAPIStore } from '../shapes/quadstores/BackendAPIStore.js';
import { BackendAPIStoreProvider } from '../shapes/quadstores/BackendAPIStoreProvider.js';

// `askQuery` crosses the wire exactly like the other query kinds: the client
// store ships `toJSON()` through Server.call, the provider rehydrates it with
// `fromJSON()` and answers through LinkedStorage.

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
    expect(calls[0][0]).toBe(store);
    expect(calls[0][1]).toEqual({ method: 'askQuery', rejectOnError: true });
    expect(calls[0][2]).toEqual(query.toJSON());
  });
});

describe('BackendAPIStoreProvider.askQuery', () => {
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
    const provider = Object.create(BackendAPIStoreProvider.prototype);

    await expect(provider.askQuery(undefined, json)).resolves.toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].__queryKind).toBe('ask');
    expect(received[0].toJSON()).toEqual(json);
  });
});

describe('BackendAPIStore.countQuery', () => {
  it('forwards the count as DSL-JSON via Server.call', async () => {
    const calls: any[] = [];
    (Server as any).call = async (...args: any[]) => {
      calls.push(args);
      return 3;
    };
    const store = new BackendAPIStore({ id: 'http://example.org/store' });
    const query = CountBuilder.fromJSON({
      op: 'count',
      shape: (BackendAPIStore as any).shape.id,
    });

    await expect(store.countQuery(query)).resolves.toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(store);
    expect(calls[0][1]).toEqual({ method: 'countQuery', rejectOnError: true });
    expect(calls[0][2]).toEqual(query.toJSON());
    // The envelope keeps its discriminator, so a backend that predates count
    // rejects it instead of reading it as a select and answering with rows.
    expect(calls[0][2].op).toBe('count');
  });
});
