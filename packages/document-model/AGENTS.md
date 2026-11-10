# Document Model Conventions

## Boundary

- This package owns the pure, schema-versioned Room Document model shared by
  Web and Document Runtime: BlockNote schema, Yjs assembly and validation,
  reference inspection, Selection Anchor resolution, proposal application,
  deterministic materialization, export, and full-state fingerprinting.
- It must not own HTTP, persistence, Room permission, React state, process
  startup, Jobs, Artifact lifecycle, or object storage.

## Structure

- Keep code flat while one cohesive behavior cluster remains small. Create a
  feature directory only when its implementation and interface-level tests
  move together; do not add nested export-only barrels.
- Preserve the package entrypoint at `src/index.ts` once executable code is
  introduced. Cross-boundary callers import the package name, never a deep
  path.
- Test deterministic behavior through exported interfaces with fixed
  Yjs/BlockNote fixtures. Do not test private helpers or reproduce the
  implementation to compute expected values.
