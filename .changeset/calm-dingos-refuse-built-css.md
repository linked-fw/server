---
'@_linked/server': patch
---

Exclude public build output and already transformed CSS modules from Vite's
SSR source-CSS collector, preventing invalid `?direct&inline` module requests.
