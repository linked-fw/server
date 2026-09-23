---
'@_linked/server': patch
---

Ontology terms are no longer individual module exports.

`lincd-server.ts` exported all 11 of its terms as module-scope bindings, and
several of those names are also shape class names in this package —
`LincdWebApp`, `LincdAPI`, `BackendAPIStore` and others. Two bindings of the
same name in one bundle scope make the bundler rename one of them:

```js
Ju = ns("BackendAPIStore")        // the term keeps the binding
n(nt, "BackendAPIStore2")         // the class is renamed
```

When the loser is a shape class, `constructor.name` is its IRI and the name
`Server.call` routes on, so a production client asks the backend for a shape it
has never heard of and the call answers 501.

Terms are now reached only through the `lincdServer` namespace object:

```ts
import { lincdServer } from '@_linked/server/ontologies/lincd-server';
lincdServer.LincdWebApp;   // instead of a bare `LincdWebApp` import
```

Nothing imported a term individually, so no call site changes.
