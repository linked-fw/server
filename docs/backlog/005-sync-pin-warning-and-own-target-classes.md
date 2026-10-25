---
summary: >
  `syncPinWarning` matches a shape by walking up its class chain, so a sub-shape with its OWN
  target class (CN's CatalogNodeShape ⊑ NodeShape, targetClass createNow:CatalogNodeShape) is
  reported although the syncs' sh:NodeShape data never matches it. Stopping the walk at an own
  targetClass breaks the intended owl:Restriction case; add owl:Restriction to the watched classes
  instead. Low priority: the warning only fires when the boot syncs run.
packages: [server]
---

# Sync-pin warning and sub-shapes with their own target class

## Problem

`watchedClassOf` in `src/utils/graphTargets.ts` returns the first watched target class anywhere up
the shape's class chain. A sub-shape that declares its own `static targetClass` is then reported as
the parent's class, although its instances carry its own class and the syncs' data never reads
through it.

The test "names an ontology term shape and its sub-shapes, pinned through the parent" in
`src/tests/graph-targets.test.ts` relies on that walk: `TermRestriction` declares
`targetClass = owl:Restriction` and is expected as `owl:Class`.

## Proposal

Stop the walk at the first class that declares its own `targetClass`, and add `owl:Restriction`
to the classes the ontology sync is watched for, so the restriction case keeps being reported.
