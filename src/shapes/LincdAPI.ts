import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import { server } from '../ontologies/server.js';
import { JSONParser } from '@_linked/server-utils/utils/JSONParser';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { JSONWriter } from '@_linked/server-utils/utils/JSONWriter';
import { SparqlDataset as SPARQLStore } from '@_linked/core/sparql/SparqlDataset';
import {
  authorizeGenericQuery,
  authorizeRawQuery,
  toQueryBuilder,
} from '../utils/queryPlane.js';
import { getRpcExposureMode } from '../utils/rpcExposure.js';

/** An error carrying an HTTP status, such as a `ServerCallError` (401/403). */
function isStatusError(error: any): error is { status: number; message: string } {
  return (
    !!error &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 600 &&
    error.name === 'ServerCallError'
  );
}

// Named explicitly: tsc emits `let X = class X`, and any later esbuild pass over that JS (Vite's
// SSR `define` replacement runs one on every file mentioning a defined `process.env.*`) renames
// the inner binding to `X2`, which would otherwise become this shape's IRI.
@linkedShape({name: 'LincdAPI'})
export class LincdAPI extends Shape {
  static targetClass = server.LincdAPI;

  async process(
    request,
    response,
    httpMethod: 'get' | 'post' | 'put' | 'delete'
  ) {
    let { method, action } = request.params;
    const body = JSONParser.parseObject<any>(request.body, {
      shapeClasses: getRpcExposureMode() === 'enforce' ? 'reject' : 'warn',
    });

    //replace - with _ in action names
    let localMethod = httpMethod + '_' + method.replace(/-/g, '_');
    if (typeof this[localMethod] !== 'function') {
      throw new Error('Unknown method: ' + localMethod);
    }

    // The query routes (`post_*`) check access themselves, through
    // utils/queryPlane.
    try {
      const result = await this[localMethod](body, request, response);
      if (typeof result !== 'undefined' || !response.headersSent) {
        const jsonObject = JSONWriter.toJsObject(result);
        response.json(jsonObject);
      }
    } catch (error) {
      if (!response.headersSent && isStatusError(error)) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      console.error(`Error while processing ${localMethod}:`, error);
      if (!response.headersSent) {
        const message =
          error instanceof Error ? error.message : 'Unknown server error';
        response.status(500).json({ error: message });
      }
    }
  }

  async post_select({ query }) {
    const builder = toQueryBuilder(query);
    await authorizeGenericQuery('select', query, builder, 'api/select');
    return LinkedStorage.selectQuery(builder);
  }
  async post_create({ query }) {
    const builder = toQueryBuilder(query);
    await authorizeGenericQuery('create', query, builder, 'api/create');
    return LinkedStorage.createQuery(builder);
  }
  async post_update({ query }) {
    const builder = toQueryBuilder(query);
    await authorizeGenericQuery('update', query, builder, 'api/update');
    return LinkedStorage.updateQuery(builder);
  }
  async post_delete({ query }) {
    const builder = toQueryBuilder(query);
    await authorizeGenericQuery('delete', query, builder, 'api/delete');
    return LinkedStorage.deleteQuery(builder);
  }

  async post_select_raw({ query }) {
    // A raw SPARQL string cannot be analysed for the shapes it touches: the
    // `rawQueries` setting decides (a session by default, or off).
    await authorizeRawQuery(query, 'api/select-raw');
    this.checkRawQuerySupport();
    return (LinkedStorage.getDefaultDataset() as unknown as SPARQLStore).rawQuery(
      query
    );
  }

  private checkRawQuerySupport() {
    if (!(LinkedStorage.getDefaultDataset() as unknown as SPARQLStore).rawQuery) {
      throw new Error(
        `Default store (${
          Object.getPrototypeOf(LinkedStorage.getDefaultDataset()).constructor
            .name
        }) does not support raw SPARQL queries`
      );
    }
  }
}
