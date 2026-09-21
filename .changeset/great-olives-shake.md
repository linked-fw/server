---
'@_linked/server': patch
---

Bootstrap a Vite-built entry as an ES module.

React renders `bootstrapScripts` as a plain `<script src async>`. Vite always
emits the client entry as an ES module, so every production build died on the
first line with "Cannot use import statement outside a module" and the app
never hydrated. When the entry was resolved from a Vite manifest it is now
passed as `bootstrapModules` instead. A legacy webpack bundle is still a
classic script and keeps `bootstrapScripts`.
