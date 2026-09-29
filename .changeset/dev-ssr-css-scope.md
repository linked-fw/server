---
'@_linked/server': patch
---

Dev SSR inlines only the CSS the rendered page needs. The dev server preloads every page into
Vite's module graph, so `<style id="ssr-css">` carried every page's stylesheets on every page
(2.3 MB in Create Now). It now holds what the app module and the matched routes' pages import
statically — what a production build puts in the entry CSS plus the route's CSS (0.78–1.1 MB in
Create Now, most of it Tailwind's output). Falls back to the whole graph when the page cannot be
determined, such as a route rendered through a `render` function.
