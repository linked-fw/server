---
'@_linked/server': minor
---

New server option `server.rawQueries: 'off' | 'session'` (or the `LINKED_RAW_QUERIES` environment variable; the config wins) decides who may run raw SPARQL through `/api/select-raw`. `'session'`, the default, runs it for any signed-in session; `'off'` refuses it. An invalid value turns raw queries off, with a warning. The JSON body parser no longer keeps the unparsed body on `request.rawBody`. Requires `@_linked/server-utils` ^1.10.0.

### Behaviour changes

- `/api/select-raw` now needs a signed-in session (401 without one, in every `rpcExposure` mode), or is refused (403) when `rawQueries` is `'off'`. Before, it was refused unless the app registered a raw query authorizer (`registerRawQueryAuthorizer`, now removed from server-utils), which could also admit a caller without a session. Apps that do not want raw SPARQL reachable should set `rawQueries: 'off'`.
