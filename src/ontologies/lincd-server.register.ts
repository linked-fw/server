/**
 * Registers this ontology.
 *
 * Kept out of `lincd-server.ts` because registration needs that module's whole export
 * namespace, and a module cannot import itself once a bundler is involved: Rollup
 * treats a static self-reference as a circular import and elides it, so the binding is
 * undefined at runtime and the consuming app dies at boot with `_this is not
 * defined`. `tsc` preserves it, which is why the pattern survived for as long as
 * packages were built with `tsc` alone.
 *
 * From a sibling module the same import is ordinary and survives.
 */
import * as terms from './lincd-server.js';
import {loadData, ns} from './lincd-server.js';
import {linkedOntology} from '../package.js';

linkedOntology(
  terms,
  ns,
  'lincd-server',
  loadData,
  '../data/lincd-server.json'
);
