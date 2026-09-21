---
'@_linked/server': patch
---

`LocalFileStore` no longer extends `Shape`.

It used nothing from `Shape`: no `this.id`, no `this.uri`, no `nodeShape`, no
Shape statics, no property decorators, and no caller anywhere treats it as a
Shape. The only inherited behaviour was `super({id})` writing an id nothing read.

Stores and datasets stopped being Shapes deliberately in core `0e8c86e`
("datasets are not shapes"), and `Shape`'s instantiation guard is currently
deferred naming this class as the reason it had to be. This removes one of the
last obstacles to re-enabling that guard.

No API change: the constructor still accepts both the `string` and `{id}` forms,
and the class still implements `IFileStore` in full.
