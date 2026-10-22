---
summary: >
  Three lows from the review of the ontology phase, not fixed: a thrown shape check makes
  `POST /admin/sync-shapes` answer 500; the boot parses the ontology hierarchy twice; a workspace
  package built once keeps registering its ontologies from a stale `lib/` in dev.
packages: [server]
---

# 001 — Ontology phase: review lows

Source: CN plan 070, independent review of `store-inference` (reports 010-012).

## 1. A thrown shape check answers 500

`runOntologyPhase` (`src/utils/ontologySync.ts`) records a shape check that throws as the phase's
`failure` (when the sync did not fail first), and `syncOntologiesThenShapes` rethrows it after the
shape sync, so the route answers 500 although both syncs succeeded. The shape check never stops a
running app at boot; on the route a bug in the check reads as a failed sync.

First questions: report it in the body (`shapeCheck: {failed: message}`) with 200, keeping 500 for
a failed sync? A test through `syncOntologiesThenShapes`.

## 2. The hierarchy is parsed twice per boot

The ontology sync parses every package's Turtle and sets the in-memory hierarchy; the shape check
is then called without `hierarchy` and loads it again (`loadOntologyHierarchy`), parsing the same
data a second time. With schema.org's hierarchy that is measurable boot time.

First questions: pass the hierarchy the sync already set into `checkShapeHierarchy` (does core
expose it, or does `checkShapeHierarchy` need a "use the in-memory hierarchy" option)? Measure the
boot before and after.

## 3. A dev package built once keeps registering from a stale `lib/`

`registerInstalledOntologies` imports `lib/esm/ontologies/*.register.js` when any exist and falls
back to `src/ontologies/*.register.ts` (through `importModule`) only when there are none. A
workspace package built once and then edited in dev keeps registering the old built data: its
ontology changes reach neither the sync nor the shape check until it is rebuilt.

First questions: in dev (Vite present), prefer the source register modules when `src/` is newer
than `lib/`, or always? Does this belong in core's `registerInstalledOntologies` (an option) or in
the server's choice of directories?
