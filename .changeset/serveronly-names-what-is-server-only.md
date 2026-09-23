---
'@_linked/server': patch
---

`linked.serverOnly` now names what is actually server-only.

It declared wildcards:

```jsonc
"serverOnly": [".", "./shapes/*", "./server/*", "./utils/*"]
```

Of the thirteen modules under `shapes/` and `utils/`, **two** reach a node
builtin. The rest are client-safe and were being reported as server-only to
every consumer — including `BackendAPIStore`, the client-side store that is
meant to be imported by a frontend. `./server/*` matched nothing at all.

Consumers that enforce a client/server boundary from these declarations were
therefore flagging correct code, and the usual repair — an allowlist entry, or
relocating the module — made things worse rather than better.

The declaration now lists the six subpaths that genuinely are server-only. No
code moved and no module changed.
