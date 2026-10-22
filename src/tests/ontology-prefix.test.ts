import { describe, expect, it } from '@jest/globals';
import { definedTermsFromTurtle } from '@_linked/core/ontology/hierarchy';
import { Prefix } from '@_linked/core/utils/Prefix';
import { packageExports } from '../package.js';
import '../ontologies/server.register.js';
import { lincdServer, loadData, ns, server } from '../ontologies/server.js';
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
    expect((packageExports as any).server?._data).toEqual(['../data/server.ttl']);
  });

  it('ships its data as Turtle under the `server:` prefix', async () => {
    const texts = await loadData();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(`@prefix server: <${NS}> .`);
    expect(texts[0]).not.toContain('lincd-server');
    const defined = await definedTermsFromTurtle(texts);
    // The ontology node and every term of the namespace object.
    const terms = Object.values(server).map((term) => term.id);
    expect([...defined].sort()).toEqual([NS, ...terms].sort());
  });

  it('keeps the deprecated export and module path as aliases', () => {
    expect(lincdServer).toBe(server);
    expect(oldModule.server).toBe(server);
    expect(oldModule.lincdServer).toBe(server);
  });
});
