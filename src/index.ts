import './types.js';
import './ontologies/lincd-server.register.js';

//SHAPES FIRST
import './shapes/index.js';
// Not shapes (plain store classes); kept so the entry's module graph is unchanged.
import './shapes/quadstores/BackendAPIStore.js';
import './shapes/filestores/LocalFileStore.js';

//THEN COMPONENTS
import './utils/accessUrl.js';

//TYPES — re-exported from @_linked/server-utils (canonical location)
export type {
  RouteConfig,
  RoutesConfig,
  RoutesModule,
} from '@_linked/server-utils/types/RouteConfig';
