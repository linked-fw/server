---
summary: >
  Core's `syncShapeGraphs` prunes orphaned shape graphs only without a `packages` filter, and a
  `turtleFor` that answers undefined makes core generate the Turtle. The server leaves a package
  without `shapes.ttl` out through `packages`, so `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true` prunes
  nothing while any registered package lacks the file.
packages: [server, core]
---

# 003 — Shape graph pruning while a package has no `shapes.ttl`

Source: CN plan 071, server report 014.

## The gap

An installed package without `lib/esm/data/shapes.ttl` gets no shape graph and no generated
Turtle (plan 071, open question 6). Core's `syncShapeGraphs` has no way to skip one package: a
`turtleFor` that returns `undefined` (or `null`) falls back to `packageShapesTurtle`. The server
therefore passes `packages` (every registered package with Turtle), and core runs
`orphanScope: 'all'` only without `packages`. Until every package ships `shapes.ttl` (after
plan 071's R2 re-publishes them), an operator who sets `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true`
gets a warning and no pruning.

## First questions

- Core: let `turtleFor` skip a package (a distinct answer such as `false`, or an option
  `generate: false`), so the server can drop the `packages` filter; or let `orphanScope: 'all'`
  run with `packages` by taking "registered" from `packagesWithShapes()` rather than the filter.
- Is the warning enough once R2 has re-published every package with shapes?
