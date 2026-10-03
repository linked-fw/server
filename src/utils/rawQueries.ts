/**
 * Who may run raw SPARQL through the generic query plane (`/api/select-raw`).
 *
 * Raw SPARQL cannot be analysed for the shapes it touches, so the per-store
 * access rules of `@_linked/server-utils/utils/QueryAccess` do not apply to
 * it. This one setting decides instead:
 *
 * - `'session'` (the default): any signed-in session may run it; 401 without one.
 * - `'off'`: every raw query is refused (403).
 *
 * Set it with `server.rawQueries` in the app's config, or `LINKED_RAW_QUERIES`.
 */
import type { RawQueriesMode } from '@_linked/server-utils/utils/QueryAccess';

export type { RawQueriesMode };

let configuredMode: RawQueriesMode | undefined;
let invalidEnvWarned = false;

function parseMode(value: unknown): RawQueriesMode | undefined {
  return value === 'off' || value === 'session' ? value : undefined;
}

/**
 * Set from the server's config (`server.rawQueries`). An invalid value turns
 * raw queries off, with a warning: a typo must not open them up.
 */
export function setRawQueriesMode(mode: unknown): void {
  if (mode === undefined || mode === null) {
    configuredMode = undefined;
    return;
  }
  const parsed = parseMode(mode);
  if (!parsed) {
    console.warn(
      `[linked] server.rawQueries must be 'off' or 'session', got ${JSON.stringify(mode)}; raw queries are off`
    );
    configuredMode = 'off';
    return;
  }
  configuredMode = parsed;
}

/**
 * `server.rawQueries`, else `LINKED_RAW_QUERIES`, else `'session'`. An invalid
 * `LINKED_RAW_QUERIES` turns raw queries off.
 */
export function getRawQueriesMode(): RawQueriesMode {
  if (configuredMode) return configuredMode;
  const env = process.env.LINKED_RAW_QUERIES;
  if (env === undefined || env === '') return 'session';
  const parsed = parseMode(env);
  if (parsed) return parsed;
  if (!invalidEnvWarned) {
    invalidEnvWarned = true;
    console.warn(
      `[linked] LINKED_RAW_QUERIES must be 'off' or 'session', got ${JSON.stringify(env)}; raw queries are off`
    );
  }
  return 'off';
}
