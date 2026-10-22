---
'@_linked/server': minor
---

Ontology data: labels, descriptions and types for every term.

- `src/data/server.ttl` gains the ontology node (`dcterms:title`, `dcterms:description`,
  `owl:versionInfo`) and the seven terms it lacked (`LincdWebApp`, `LincdAPI`, `hasAPI`,
  `N3FileStore`, `BackendAPIStore`, `ownPackage`, `maintainsPackage`), and is written in the
  deterministic Turtle form. All 11 terms are typed (`owl:Class`, was `rdfs:Class`, or
  `owl:ObjectProperty`) with an English label and comment; the labels say "Linked", not "LINCD".
- Two axioms: `server:BackendFileStore` and `server:BackendAPIStore` are `rdfs:subClassOf`
  `server:BackendStore`. No shape targets these classes.
