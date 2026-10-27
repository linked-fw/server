---
summary: >
  Two lows from the review of the ontology phase, not fixed: the boot parses the ontology
  hierarchy twice (core exposes no way to hand the sync's parse to the shape check); a workspace
  package built once keeps registering its ontologies from a stale `lib/` in dev.
packages: [server, core]
---

# 001 — Ontology phase: review lows

Source: CN plan 070, independent review of `store-inference` (reports 010-012). The third low (a
thrown shape check answered `POST /admin/sync-shapes` with 500) is fixed: report 021.

## 1. The hierarchy is parsed twice per boot

The ontology sync (core `syncOntologies`) parses every package's Turtle and sets the in-memory
hierarchy (`setHierarchyFromPackages`); the shape check is then called without `hierarchy` and
loads it again (`loadOntologyHierarchy` → `readPackageOntologies`), parsing the same data a second
time. With schema.org's hierarchy that is measurable boot time.

Checked in report 021: core has no way to hand that parse on. `syncOntologies` returns no
triples, `@_linked/core/ontology/classHierarchy` keeps them in its shared state but exports only
`setOntologyHierarchy`, `superClassesOf`, `subClassesOf` and a version, and
`checkShapeHierarchy` takes a `hierarchy` array or parses. The fix needs a core change first,
then one line in `runOntologyPhase` (`src/utils/ontologySync.ts`): after a sync, pass the
in-memory triples as `hierarchy`.

First questions: core exports a getter for the triples last set (`ontologyHierarchyTriples()` in
`classHierarchy.ts`), or `checkShapeHierarchy` takes `{hierarchy: 'in-memory'}`? Measure the boot
before and after.

## 2. A dev package built once keeps registering from a stale `lib/`

`registerInstalledOntologies` imports `lib/esm/ontologies/*.register.js` when any exist and falls
back to `src/ontologies/*.register.ts` (through `importModule`) only when there are none. A
workspace package built once and then edited in dev keeps registering the old built data: its
ontology changes reach neither the sync nor the shape check until it is rebuilt.

First questions: in dev (Vite present), prefer the source register modules when `src/` is newer
than `lib/`, or always? Does this belong in core's `registerInstalledOntologies` (an option) or in
the server's choice of directories?
