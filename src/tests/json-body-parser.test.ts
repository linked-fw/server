import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { AddressInfo } from 'net';
import { LinkedServer, registerCallRoutes } from '../shapes/LinkedServer.js';
import { createJsonBodyParser } from '../utils/jsonBodyParser.js';

// Pins what the request body parser LinkedServer mounts actually does, so a
// parser swap (or the Express 5 move, which brings body-parser 2) has to keep it.

const servers: any[] = [];

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

async function listen(app: any): Promise<string> {
  const s = await new Promise<any>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function makeLinkedServer(provider: any): any {
  const server: any = Object.create(LinkedServer.prototype);
  server.genericProviders = new Map([['pkg', provider]]);
  server.shapeProviders = new Map();
  server.initRequest = async () => {};
  return server;
}

/** An app wired like LinkedServer: the real parser in front of the real /call handler. */
async function callApp(provider: any): Promise<string> {
  const linkedServer = makeLinkedServer(provider);
  const app = express();
  app.use(createJsonBodyParser());
  registerCallRoutes(app, linkedServer);
  return listen(app);
}

/** An app that reports what the parser left on the request. */
async function probeApp(): Promise<string> {
  const app = express();
  app.use(createJsonBodyParser());
  app.post('/probe', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () =>
      res.json({
        body: req.body ?? null,
        streamBytes: Buffer.concat(chunks).length,
      })
    );
  });
  return listen(app);
}

describe('JSON body parsing on /call', () => {
  it('delivers Server.call arguments to the provider method', async () => {
    const echo = jest.fn((...args: any[]) => ({ got: args }));
    const base = await callApp({ initRequest() {}, echo });

    const res = await fetch(`${base}/call/pkg/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['a', 1, { nested: [true, null] }] }),
    });

    expect(res.status).toBe(200);
    expect(echo).toHaveBeenCalledWith('a', 1, { nested: [true, null] });
    expect(await res.json()).toEqual({ got: ['a', 1, { nested: [true, null] }] });
  });

  it('accepts a payload far above the 100kb default (10mb)', async () => {
    const echo = jest.fn((s: string) => s.length);
    const base = await callApp({ initRequest() {}, echo });
    const big = 'x'.repeat(10 * 1024 * 1024);

    const res = await fetch(`${base}/call/pkg/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [big] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toBe(big.length);
  }, 30000);

  it('rejects a payload above 50mb with 413 before reaching the provider', async () => {
    const echo = jest.fn(() => 'reached');
    const base = await callApp({ initRequest() {}, echo });
    const tooBig = 'x'.repeat(51 * 1024 * 1024);

    const res = await fetch(`${base}/call/pkg/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [tooBig] }),
    });

    expect(res.status).toBe(413);
    expect(echo).not.toHaveBeenCalled();
  }, 30000);

  it('answers malformed JSON with 400', async () => {
    const echo = jest.fn(() => 'reached');
    const base = await callApp({ initRequest() {}, echo });

    const res = await fetch(`${base}/call/pkg/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"args": [',
    });

    expect(res.status).toBe(400);
    expect(echo).not.toHaveBeenCalled();
  });
});

describe('non-JSON bodies pass through unparsed', () => {
  it('leaves a multipart upload stream unread for the upload handler', async () => {
    const base = await probeApp();
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(200 * 1024, 1)]), 'a.bin');

    const res = await fetch(`${base}/probe`, { method: 'POST', body: form });
    const out: any = await res.json();

    expect(res.status).toBe(200);
    expect(out.body).toEqual({});
    expect(out.streamBytes).toBeGreaterThan(200 * 1024);
  });

  it('does not parse urlencoded forms', async () => {
    const base = await probeApp();

    const res = await fetch(`${base}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a[b]=1&c=2',
    });
    const out: any = await res.json();

    expect(out.body).toEqual({});
    expect(out.streamBytes).toBe('a[b]=1&c=2'.length);
  });

  it('does not parse JSON sent without a JSON content type', async () => {
    const base = await probeApp();

    const res = await fetch(`${base}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"args":[]}',
    });
    const out: any = await res.json();

    expect(out.body).toEqual({});
  });
});
