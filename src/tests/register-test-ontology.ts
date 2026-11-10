import { isRegisteredPackage, linkedPackage, setOntologyRegistration } from '@_linked/core/utils/Package';

/**
 * Registers an ontology for a test with its data held in memory: `load` returns the Turtle texts.
 * A package registers with `registerOntologies`, which reads data files; a test without files
 * uses this instead. Registers the package first when it is not yet.
 */
export function registerTestOntology(
  packageName: string,
  ontology: { name: string; namespace: string; load: () => Promise<string[]>; files: string },
): void {
  if (!isRegisteredPackage(packageName)) linkedPackage(packageName);
  setOntologyRegistration({
    packageName,
    name: ontology.name,
    namespace: ontology.namespace,
    files: [ontology.files],
    terms: {},
    load: ontology.load,
  });
}
