import { describe, expect, it } from '@jest/globals';
import { runAsDelegate, runAsSystem, runWithCallContext } from '@_linked/server-utils/utils/CallContext';
import { ServerCallError } from '@_linked/server-utils/utils/ServerCallError';
import { transactionCaller } from '../utils/serverTransactions.js';

// Who a store transaction is bound to. A delegated call (work for a known user, outside that
// user's request) must be bound to its user: bound to `system`, any system work could continue it.

const http = (linkedAuth?: any) => ({ kind: 'http', request: { linkedAuth }, response: {} }) as const;

describe('transactionCaller', () => {
  it('is the session user in an http call, and requires one', () => {
    expect(runWithCallContext(http({ userAccount: { id: 'http://ex/me' } }), transactionCaller)).toBe('user:http://ex/me');
    expect(() => runWithCallContext(http(), transactionCaller)).toThrow(ServerCallError);
  });

  it('is the user a delegate acts for in a delegated call', () => {
    const caller = runAsDelegate({ id: 'http://ex/me' }, { id: 'http://ex/connection/1' }, transactionCaller);
    expect(caller).toBe('user:http://ex/me');
    // the same user through their own request and through a delegate share a caller identity
    expect(caller).toBe(runWithCallContext(http({ userAccount: { id: 'http://ex/me' } }), transactionCaller));
  });

  it('refuses a delegated call whose account has no id', () => {
    let status: number | undefined;
    try {
      runAsDelegate({}, { id: 'http://ex/connection/1' }, transactionCaller);
    } catch (err: any) {
      status = err?.status;
    }
    expect(status).toBe(401);
  });

  it('is system for system work and outside any call (control)', () => {
    expect(transactionCaller()).toBe('system');
    expect(runAsSystem(transactionCaller, 'job')).toBe('system');
    expect(runAsDelegate({ id: 'http://ex/me' }, { id: 'c' }, () => runAsSystem(transactionCaller))).toBe('system');
  });
});
