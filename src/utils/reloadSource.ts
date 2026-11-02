/**
 * Mark a package's source modules stale in Vite's module graph, so the next
 * `ssrLoadModule` of the package reads them from disk again.
 *
 * Vite's watcher does this too when a file changes, but asynchronously: a host
 * that has just written a file and asks the app for its graph content cannot rely
 * on the watcher having seen it. Invalidating a module also invalidates its
 * importers, so a changed shapes barrel reaches the package entry that imports it,
 * and a new shape module the barrel now imports is loaded with it.
 */
import * as path from 'path';

/** The subset of Vite's (back-compat) module graph this module uses. */
export interface SourceModuleGraph {
  idToModuleMap: Map<string, { file?: string | null }>;
  onFileChange(file: string): void;
}

/**
 * Invalidate every module whose file lies under one of `roots` and outside any
 * `node_modules` directory. Returns the files it invalidated.
 */
export function invalidateSourceUnder(
  graph: SourceModuleGraph,
  roots: string[]
): string[] {
  const prefixes = roots.map((r) => path.resolve(r) + path.sep);
  const files = new Set<string>();
  for (const mod of graph.idToModuleMap.values()) {
    const file = mod?.file;
    if (!file) continue;
    if (file.split(path.sep).includes('node_modules')) continue;
    if (prefixes.some((p) => file.startsWith(p))) files.add(file);
  }
  for (const file of files) graph.onFileChange(file);
  return [...files];
}
