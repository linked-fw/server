import { linkedShape } from '../package.js';
import { lincdServer } from '../ontologies/lincd-server.js';
import { Shape } from '@_linked/core/shapes/Shape';
import { objectProperty } from '@_linked/core/shapes/SHACL';
import { Lincd_API_Client } from '@_linked/server-utils/shapes/Lincd_API_Client';

// Named explicitly: tsc emits `let X = class X`, and any later esbuild pass over that JS (Vite's
// SSR `define` replacement runs one on every file mentioning a defined `process.env.*`) renames
// the inner binding to `X2`, which would otherwise become this shape's IRI.
@linkedShape({name: 'LincdWebApp'})
export class LincdWebApp extends Shape {
  static targetClass = lincdServer.LincdWebApp;

  static get localApp() {
    return new LincdWebApp({ id: process.env.SITE_ROOT });
  }

  // Module and packages properties removed — lincd-modules is in modules_old.
  // These will be re-added when the shape is properly migrated to @_linked/core query patterns.

  @objectProperty({
    path: lincdServer.hasAPI,
    shape: Lincd_API_Client,
    maxCount: 1,
  })
  get api(): Lincd_API_Client {
    return undefined as any;
  }
}
