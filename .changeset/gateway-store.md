---
"@_linked/server": minor
---

GatewayStore: an IDataset that forwards Linked Queries to a gateway. Exported at `@_linked/server/shapes/quadstores/GatewayStore` so an app can select it from `linked.backend.datasets.json`; it posts each query as DSL-JSON with a bearer credential and throws `GatewayUnreachableError` from `init()` when the gateway does not answer.
