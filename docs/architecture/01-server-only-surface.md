---
summary: Why this package declares its own server-only surface rather than being named by
  consumers, what the declaration means, and the one part of this package that is not server-only
  and should not live here.
---

# This package's server-only surface

This package is a **replaceable module**. An application may swap it for another implementation,
and anything that depends on knowing it by name breaks the moment someone does.

That matters for one specific rule: **a frontend bundle must not contain this package.** Almost
everything here touches a filesystem, a process or a socket, and a `ShapeProvider` extends
`BackendProvider`, which imports node's `path`. Pull any of it into a client graph and the bundler
resolves `path` to the abandoned npm shim of the same name, the shim references `process`, and the
application hydrates into an empty shell with `ReferenceError: process is not defined` — an error
naming nothing that would lead you back to the import.

## The declaration

```jsonc
"linked": {
  "serverOnly": [".", "./shapes/*", "./server/*", "./utils/*"]
}
```

A consuming application's client/server boundary check reads this, rather than hardcoding
`@_linked/server`. The difference is not stylistic: a check that names this package protects one
arrangement of the framework, and a replacement inherits none of it. A check that reads
declarations protects whatever is installed.

It is purely declarative. No code, no exports, and no resolution behaviour depends on it.

## The convention it complements

A consumer also treats anything under `<pkg>/backend/**` as server-only, in **any** package, with
no declaration needed. Between the two, no application has to know a package by name.

A package whose server-only code all lives under `backend/` therefore needs no `linked.serverOnly`
at all. This package declares one because its server-only surface predates that convention and is
spread across several subpaths.

## What is not server-only, and should move

Three exports are client-safe and are published from here anyway:

| Export | Who uses it |
|---|---|
| `BackendAPIStore` | the store a **browser** uses to talk to the backend; constructed by an app's frontend storage config |
| `getAccessUrlLocalFileStore` | the same frontend config |
| `LincdWebApp` | constructed in a React hook |

They belong in `@_linked/server-utils`, which exists for exactly the isomorphic half of the
framework. Until they move, every consuming application must carry a standing exception in its
boundary check — and a boundary with permanent exceptions stops being one.

Tracked as follow-up work; noted here so the next person to wonder why an app imports
`@_linked/server` from its frontend finds the answer.
