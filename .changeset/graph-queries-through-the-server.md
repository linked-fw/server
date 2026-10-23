---
'@_linked/server': minor
---

Graph queries through the server (named graphs and the graph registry, `@_linked/core`'s
`graphQuery`):

- `RemoteDataset.graphQuery`: graph queries (`graph_create`, `graph_replace`, `graph_patch`,
  `graph_drop`) go out on the query wire like every other query, with the same token and
  end-user header. A refusal comes back as core's `GraphQueryError` with its code; a server or
  gateway without the method (404, 501) reads as `unsupported-query-kind`, so the ontology sync
  falls back to the default graph there.
- In the url form, `RemoteDataset` expands `graphs.allOntologies` and `graphs.allShapes` in a
  read's `.from()` set from its own graph-registry cache (per dataset, keyed by the dataset the
  server names in its `ping`, updated by its own graph queries, re-read after 30 seconds);
  `invalidateGraphRegistry(dataset?)` drops it.
- The generic plane answers `/call/@_linked/server/graphQuery`: the body is checked with core's
  `parseGraphQuery`, the `graph` rule of the store its record class routes to decides
  (`withAccess({graph})`; no rule refuses with 403), and `LinkedStorage.graphQuery` runs it. A
  store's refusal answers with a status and its code: `{error, code}` (409 `graph-exists`, 409
  `graph-not-registered`, 400 `graph-name-read-only`, 501 `unsupported-query-kind`). Any
  `ServerCallError` carrying a string `code` now sends it in the error body.
- Control channel: `POST /admin/graph-registry-changed {dataset}` (with `CN_APP_ADMIN_SECRET`)
  drops the process's cached graph registry, so the next expanding read re-reads it.
- The ontology phase (boot and `POST /admin/sync-shapes`) reports and logs the graphs the sync
  wrote and dropped (`ontologies.graphs`, `ontologies.droppedGraphs`), and says when a store
  without graph queries got the default-graph sync.

Breaking changes:

- Requires the `@_linked/core` with graph queries (`IDataset.graphQuery`, `NamedGraph`, the graph
  registry cache), which in turn requires `ghcr.io/linked-fw/fuseki:6.2.0-2` or a store that
  builds its hierarchy from the registry.
- Graph queries on the generic plane are refused unless the store declares a `graph` rule with
  `withAccess` (`@_linked/server-utils` with the `graph` operation).
- `RemoteDataset` implements the now-required `IDataset.graphQuery`; its `selectQuery` and
  `askQuery` are `async` (they may read the registry first).
