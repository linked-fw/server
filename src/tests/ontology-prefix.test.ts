import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { Prefix } from '@_linked/core/utils/Prefix';
import { packageExports } from '../package.js';
import '../ontologies/server.register.js';
import { lincdServer, ns, server } from '../ontologies/server.js';
import * as oldModule from '../ontologies/lincd-server.js';

// A first-party ontology's prefix label equals its ontologySlug, which for this
// package is its publicSlug: `server`, namespace https://linked.cm/ont/server/.
const NS = 'https://linked.cm/ont/server/';

describe('server ontology', () => {
  it('lives on https://linked.cm/ont/server/', () => {
    expect(ns('').id).toBe(NS);
    expect(server.LincdAPI.id).toBe(NS + 'LincdAPI');
  });

  it('compacts to the `server:` prefix', () => {
    expect(Prefix.toPrefixed(NS + 'LincdAPI')).toBe('server:LincdAPI');
    expect(Prefix.toFull('server:LincdAPI')).toBe(NS + 'LincdAPI');
  });

  it('still expands the deprecated `lincd-server:` prefix', () => {
    expect(Prefix.toFull('lincd-server:LincdAPI')).toBe(NS + 'LincdAPI');
  });

  it('is registered in the package tree under its prefix', () => {
    expect((packageExports as any).server?._prefix).toBe('server');
    expect((packageExports as any).server?._data).toBe('../data/server.json');
  });

  it('uses `server` as the JSON-LD @context key of its data file', () => {
    const data = JSON.parse(
      readFileSync(new URL('../data/server.json', import.meta.url), 'utf8')
    );
    expect(data['@context'].server).toBe(NS);
    expect(data['@context']['lincd-server']).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('lincd-server:');
  });

  it('keeps the deprecated export and module path as aliases', () => {
    expect(lincdServer).toBe(server);
    expect(oldModule.server).toBe(server);
    expect(oldModule.lincdServer).toBe(server);
  });
});
