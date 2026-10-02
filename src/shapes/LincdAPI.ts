import { Shape } from '@_linked/core/shapes/Shape';
import { linkedShape } from '../package.js';
import { server } from '../ontologies/server.js';
import { JSONParser } from '@_linked/server-utils/utils/JSONParser';
import { LinkedStorage } from '@_linked/core/utils/LinkedStorage';
import { JSONWriter } from '@_linked/server-utils/utils/JSONWriter';
import { cached } from '@_linked/core/utils/cached';
import { getShapeIndex, ShapeDetails } from '../utils/Shapes.js';
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

const cacheTime = process.env.NODE_ENV === 'development' ? 0 : Infinity;
export type ShapeSummary = {
  id: string;
  label: string;
  description: string;
  target: { id: string };
  extends?: { id: string };
  numInstances: number;
};
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
    // utils/queryPlane. The `get_*` routes describe shapes and stay reachable:
    // apps read each other's `/api/all-shapes` server to server.
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

  get_shape_details({
    shapes,
  }: {
    shapes: string[];
  }): Record<string, ShapeDetails> {
    return cached(
      () => {
        const shapeIndex = getShapeIndex();
        const filteredShapeIndex = {};
        for (const shapeId of shapes) {
          if (shapeIndex[shapeId]) {
            filteredShapeIndex[shapeId] = shapeIndex[shapeId];
          }
        }
        return filteredShapeIndex;
      },
      [shapes],
      cacheTime
    );
  }

  get_all_shapes(): Promise<{
    shapes: Record<string, ShapeDetails>;
    defaultGraph: string;
  }> {
    return cached(
      async () => {
        const shapeIndex = getShapeIndex();

        const typesWithInstances = new Map<string, number>();
        this.checkRawQuerySupport();
        await (LinkedStorage.getDefaultDataset() as unknown as SPARQLStore)
          .rawQuery(
            `SELECT (COUNT(?s) AS ?count) ?type WHERE { ?s a ?type } GROUP BY ?type`
          )
          .then((results) => {
            // rawQuery also types ASK results (a boolean envelope); this is a SELECT.
            if (!results || !('results' in results)) return;
            results.results.bindings.forEach((binding) => {
              if (binding.type && binding.type.value) {
                typesWithInstances.set(
                  binding.type.value,
                  parseInt(binding.count.value)
                );
              }
            });
          })
          .catch(console.error);

        const shapesWithInstances: Record<string, ShapeDetails> = {};
        for (const shapeId in shapeIndex) {
          const shape = shapeIndex[shapeId];
          shapesWithInstances[shapeId] = {
            ...shape,
            numInstances: typesWithInstances.get(shape.targetClass?.id) || 0,
          };
        }
        return {
          shapes: shapesWithInstances,
          defaultGraph: process.env.DATA_ROOT,
        };
      },
      [],
      cacheTime
    );
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
    // A raw SPARQL string cannot be analysed for the shapes it touches: it is
    // refused unless the app registers a raw query authorizer.
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
