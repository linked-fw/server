/**
 * Boot-time shape materialization: write the shapes this process registered into
 * its app-data dataset as SHACL, via core `syncShapes`.
 *
 * Kept apart from `LinkedServer` so the orphan policy can be tested without
 * booting a server.
 */

/** The orphan policies a booting server may run with. */
export type BootOrphanScope = 'all' | 'none';

/** The subset of core's `syncShapes` this module calls. */
export type SyncShapesFn = (
  ds: unknown,
  options: {orphanScope: BootOrphanScope},
) => Promise<Array<() => Promise<void>>>;

/**
 * The orphan policy for boot-time sync.
 *
 * `'none'` unless the operator sets `LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true`.
 *
 * Boot sync must not delete store shapes the process did not register, because
 * the registry is routinely a subset of what the dataset holds: shapes are
 * deep-importable one file at a time, an app's backend may import no shapes at
 * all, and an app-data dataset also holds shapes other writers put there (Create
 * Now's `bindShape` / `enableCapability`). With pruning on, an app whose backend
 * imports no shapes deletes every NodeShape in its app-data on each boot.
 * `'ownedNamespaces'` is deliberately not offered: a namespace is a whole
 * package, so a deep import of one shape file still prunes the rest of it.
 */
export function bootOrphanScope(
  env: Record<string, string | undefined> = process.env,
): BootOrphanScope {
  return env.LINKED_SYNC_SHAPES_PRUNE_ORPHANS === 'true' ? 'all' : 'none';
}

/**
 * Plan and run a sync of every registered shape into `ds`, in batches of 8 so
 * Fuseki is not flooded. The orphan policy is always passed explicitly — an app
 * may be running a core whose `syncShapes` still defaults to pruning.
 *
 * Logs one line naming the policy that ran.
 */
export async function materializeShapes(
  ds: unknown,
  syncShapes: SyncShapesFn,
  {
    env = process.env,
    log = console.log,
  }: {
    env?: Record<string, string | undefined>;
    log?: (message: string) => void;
  } = {},
): Promise<{count: number; orphanScope: BootOrphanScope}> {
  const orphanScope = bootOrphanScope(env);
  const thunks = await syncShapes(ds, {orphanScope});
  for (let i = 0; i < thunks.length; i += 8) {
    await Promise.all(thunks.slice(i, i + 8).map((run) => run()));
  }
  log(
    orphanScope === 'all'
      ? `[LinkedServer] synced shapes into app-data with orphanScope 'all' ` +
          `(LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true): ${thunks.length} operation(s), ` +
          `store shapes not registered in this process were deleted`
      : `[LinkedServer] synced shapes into app-data with orphanScope 'none': ` +
          `${thunks.length} shape(s) written, no store shapes deleted ` +
          `(set LINKED_SYNC_SHAPES_PRUNE_ORPHANS=true to prune)`,
  );
  return {count: thunks.length, orphanScope};
}
