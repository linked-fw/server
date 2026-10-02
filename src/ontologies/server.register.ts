/**
 * Registers this ontology.
 *
 * Kept out of `server.ts` because registration needs that module's whole export
 * namespace, and a module cannot import itself once a bundler is involved: Rollup
 * treats a static self-reference as a circular import and elides it, so the binding is
 * undefined at runtime and the consuming app dies at boot with `_this is not
 * defined`. `tsc` preserves it, which is why the pattern survived for as long as
 * packages were built with `tsc` alone.
 *
 * From a sibling module the same import is ordinary and survives.
 */
import * as terms from './server.js';
import {loadData, ns} from './server.js';
import {linkedOntology} from '../package.js';
import {Prefix} from '@_linked/core/utils/Prefix';

// Deprecated prefix label, kept so `lincd-server:X` names still expand. It is added
// BEFORE the registration below because Prefix keeps one prefix per namespace and the
// last add wins: registering `server` second makes compaction emit `server:X`.
Prefix.add('lincd-server', ns('').id);

// The prefix is also the key this ontology is registered under in the package tree,
// and the name of its data file: `server` → `../data/server.json`.
linkedOntology(terms, ns, 'server', loadData, '../data/server.json');
