import { describe, expect, it } from '@jest/globals';
import { definedTermsFromTurtle } from '@_linked/core/ontology/hierarchy';
import { Prefix } from '@_linked/core/utils/Prefix';
import { getRegisteredOntologies, suggestedPrefixes } from '@_linked/core/utils/Package';
import '../ontologies/index.js';
import { lincdServer, ns, server } from '../ontologies/server.js';
import * as oldModule from '../ontologies/lincd-server.js';

// A first-party ontology's suggested prefix equals its ontologySlug, which for this
// package is its publicSlug: `server`, namespace https://linked.cm/ont/server/. The
// ontology registers no prefix: an app's prefix map holds the prefixes.
const NS = 'https://linked.cm/ont/server/';
const registration = () => getRegisteredOntologies().find((r) => r.packageName === '@_linked/server');

describe('server ontology', () => {
  it('lives on https://linked.cm/ont/server/', () => {
    expect(ns('').id).toBe(NS);
    expect(server.LincdAPI.id).toBe(NS + 'LincdAPI');
  });

  it('compacts to `server:` in an app map that has it', () => {
    const map = { server: NS };
    expect(Prefix.toPrefixed(NS + 'LincdAPI', map)).toBe('server:LincdAPI');
    expect(Prefix.toFull('server:LincdAPI', map)).toBe(NS + 'LincdAPI');
  });

  it('is registered by the index under its name, with its suggested prefix, adding no prefix', () => {
    expect(registration()?.name).toBe('server');
    expect(registration()?.files).toEqual(['../data/server.ttl']);
    expect(suggestedPrefixes().filter((p) => p.packageName === '@_linked/server')).toEqual([
      { packageName: '@_linked/server', name: 'server', namespace: NS, prefix: 'server' },
    ]);
    expect(Prefix.getFullURI('server')).toBeUndefined();
    expect(Prefix.getFullURI('lincd-server')).toBeUndefined();
  });

  it('ships its data as Turtle under the `server:` prefix', async () => {
    const texts = (await registration()!.load!()) as string[];
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
