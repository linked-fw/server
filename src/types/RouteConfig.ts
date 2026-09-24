import React from 'react';

/**
 * Configuration for a single route in the application
 */
export interface RouteConfig {
  /**
   * The URL path pattern for this route (e.g. "/signin", "/data/:id")
   * Supports React Router path syntax including params (:id) and wildcards (*)
   */
  path: string;

  /**
   * Component for this route (can be lazy-loaded or eager)
   * For lazy loading, use React.lazy(() => import('./Component')) with webpackChunkName comment
   * For eager loading, import the component directly
   */
  component?:
    | React.LazyExoticComponent<() => React.JSX.Element>
    | React.ComponentType<any>;

  /**
   * Custom render function for the route (alternative to component)
   */
  render?: () => React.JSX.Element;

  /**
   * Whether this route requires authentication
   * @default false
   */
  requireAuth?: boolean;

  /**
   * Whether to exclude this route from navigation menus
   * @default false
   */
  excludeFromMenu?: boolean;

  /**
   * Display label for this route in navigation/menus
   */
  label?: string;

  /**
   * Webpack chunk names to preload for this route (for SSR optimization)
   * These should match the webpackChunkName comments in lazy imports
   * @example ['signin', 'common-components']
   */
  preloadChunks?: string[];
}

/**
 * Collection of all routes in the application
 * Key is the route identifier, value is the route configuration
 */
export type RoutesConfig = Record<string, RouteConfig>;

/**
 * Module shape expected when loading routes dynamically
 * Routes can be exported as ROUTES or as default export
 */
export interface RoutesModule {
  ROUTES?: RoutesConfig;
  default?:
    | {
        ROUTES?: RoutesConfig;
      }
    | RoutesConfig;
}
