---
'@_linked/server': patch
---

`RouteConfig` compiles under React 19.

React 19 removed the global `JSX` namespace, so `RouteConfig`'s `component` and
`render` fields referenced a type that no longer exists and the package failed
to build for any consumer on React 19. They now use `React.JSX.Element`, which
is the same type under its current name.
