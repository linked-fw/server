import './types.js';
import './ontologies/lincd-server.register.js';

//SHAPES FIRST
import './shapes/LinkedServer.js';
import './shapes/LincdAPI.js';
import './shapes/quadstores/BackendAPIStore.js';
import './shapes/filestores/LocalFileStore.js';
import './shapes/LincdWebApp.js';

//THEN COMPONENTS
import './utils/accessUrl.js';

//TYPES — re-exported from @_linked/server-utils (canonical location)
export type {
  RouteConfig,
  RoutesConfig,
  RoutesModule,
} from '@_linked/server-utils/types/RouteConfig';
