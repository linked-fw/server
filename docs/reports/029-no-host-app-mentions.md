---
date: 2026-11-02
summary: >
  Comments, the readme, tests' example IRIs and current backlog no longer name the private app
  built on server; they say "a host app" and use example.org. No behaviour change, no changeset.
packages: [server]
---

# 029 — No host-app mentions

## PR

**What changed.** The private host app's name, gateway and plan/backlog numbers are gone from
`src/` (comments in `utils/graphTargets.ts`, `tests/ssr-css-scope.test.ts`; example IRIs in
`tests/boot-shape-sync.test.ts` now on `example.org`; the example dataset in
`tests/graph-targets.test.ts` is `my-app`), from `readme.md` (four lines, now "a host app" / "the
host's gateway") and from `docs/backlog/001`–`006`. **Verification:** `npx linked build`
(`✔ Build successful`), `npm test` (`Test Suites: 2 skipped, 38 passed, 38 of 40 total`,
`Tests: 2 skipped, 543 passed, 545 total`). **Deviations:** none. **Follow-ups:** none.

## Details

Comments, docs and test example values only; `GraphWriter`'s values are unchanged.
