---
"@_linked/server": patch
---

`react` and `react-dom` are now peer dependencies (`^19.0.0`) instead of runtime dependencies. The server renders the application with the application's own React, so it must share one copy with the app; declaring them as dependencies could install a second copy alongside the app's and break server-side rendering (invalid hook calls, mismatched contexts).

Apps must declare `react` and `react-dom` themselves — apps created from the app template already do, so no change is needed there. npm installs missing peers automatically.
