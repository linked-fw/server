import './types.js';
import './ontologies/server.register.js';

//SHAPES FIRST
import './shapes/index.js';
// Not shapes (plain store classes); kept so the entry's module graph is unchanged.
import './shapes/quadstores/BackendAPIStore.js';
import './shapes/filestores/LocalFileStore.js';

//THEN COMPONENTS
import './utils/accessUrl.js';

// The fatal-error contract a provider uses to refuse to let the server start.
export { FatalStartupError, isFatalError } from './utils/fatalError.js';
export type { FatalError } from './utils/fatalError.js';

//TYPES — re-exported from @_linked/server-utils (canonical location)
export type {
  RouteConfig,
  RoutesConfig,
  RoutesModule,
} from '@_linked/server-utils/types/RouteConfig';
