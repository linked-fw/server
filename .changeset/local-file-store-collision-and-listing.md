---
'@_linked/server': minor
---

`LocalFileStore` suffixes only on a real collision, and `listFiles` returns keys you can use.

**`preventDuplicates` now means what its name says.** The random `_ab12cd` suffix
was applied to *every* save, without ever checking whether the name was taken —
so a caller never got back the key it asked for. A content-hashed bundle handed
over as `main-hwqwrAvA.css` landed as `main-hwqwrAvA_x9k2ml.css`, and the name
baked into the HTML no longer resolved. `@_linked/cli` publishes app assets with
a bare two-argument `saveFile`, so it hit exactly this.

The store now checks first and suffixes only when the name is occupied,
re-checking the suffixed name in turn. **The never-clobber guarantee is
unchanged** — a taken name still gets a fresh key, and an explicit
`preventDuplicates: false` still overwrites in place. What changes is that a free
name is left alone, which is what `S3FileStore` has always done: the two
implementations of `IFileStore` now read the flag the same way.

Minor rather than patch because stored keys change shape: a first save that used
to produce `report_312acb.pdf` now produces `report.pdf`. Anything that recorded
a returned `storedPath` keeps working; anything that *assumed* every key carries
a suffix should re-read `storedPath`, which has always been the supported way to
learn the key.

**`listFiles` is usable for the first time.** It returned keys joined onto
`basePath` (`data/uploads/x.txt`) while every other method on the store resolves
its argument *against* `basePath` — so feeding a result straight back into
`getFile` looked for `data/uploads/data/uploads/x.txt` and found nothing. Keys
are now relative to the base folder, matching `S3FileStore`, which strips its
bucket prefix before returning.

Two more bugs went with it: the recursive branch called `listFiles(prefix)`,
which re-read `basePath` and found the same directory again — unbounded
recursion as soon as the store held a single folder — and the `prefix` argument
was accepted and then ignored entirely. Subdirectories are now walked properly
and `prefix` filters the returned keys.
