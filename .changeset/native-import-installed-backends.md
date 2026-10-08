---
'@_linked/server': patch
---

Installed linked packages with a backend are now loaded once, through Node. Under an app's dev SSR runner the backend loader's `import()` was rewritten by Vite's SSR transform, so each installed package's backend was evaluated a second time and whichever copy registered last owned the shape registry — properties added to a shape by another package could go missing. The loader now uses a native `import()` the transform cannot rewrite.
