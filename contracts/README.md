# Process Contracts

This directory owns authoritative cross-process OpenAPI and the generated Go
and TypeScript modules consumed directly by Web, Agent, and TeamHub. It owns no
product policy or application behavior.

## Layout

```text
openapi/
  components/
  paths/
  teamhub-public/
    teamhub-api.openapi.yaml
  teamhub-agent-api/
    openapi.yaml            # Agent CLI -> TeamHub business API, incl. CLI files
  teamhub-internal/
    openapi.yaml            # Node Services / Voice Runtime -> TeamHub
  node-services-internal/
    openapi.yaml            # TeamHub -> Node Services (4319 and 4321)
runner-gateway/
  asyncapi.yaml             # Runner Gateway WebSocket channel
  envelope.schema.json
  fixtures/
fixtures/
  service-credentials/      # shared TypeScript and Go derivation vectors
generated/
  typescript/
    package.json            # @linger/wire-contracts
    src/
      generated/<id>/       # written by generation only
      generated/runner-gateway/
      <id>/client.ts        # handwritten clients and servers
  go/
    <package>/              # written by generation only
codegen/
  contracts.ts              # generate and verify every contract
```

The LLM Wiki operations in `node-services-internal` define the stateless document normalization and Wiki
refresh candidate generation that TeamHub calls; TeamHub owns scheduling,
source selection, and settlement.
After consolidation, `contracts/openapi` is the only authority. Applications
must not retain copied schemas or app-local generated wire DTOs.

Generate every language boundary from the authoritative OpenAPI with:

```bash
make contracts-generate
make contracts-verify
```

`contractEntries` in `codegen/contracts.ts` lists every top-level contract
once: its id, its entrypoint, and, when Go uses it, `go: { package, mode }` with mode `client`
(types and a client for Go callers) or `types` (types only, for the contracts
TeamHub serves through its own route table). Generation and verification read only that list. Generation
clears `generated/typescript/src/generated/` and each listed Go package
directory, bundles all references, and writes `types.ts` and `openapi.gen.go`
there. Verification generates into a temporary directory, compares those
directories whole, and fails on any directory that no contract owns.
Generated files are committed and never edited by hand.

Handwritten clients and servers live in `generated/typescript/src/<id>/` and
import their types from `../generated/<id>/types.js`. The package exports only
`<id>/types`, `<id>/client`, `<id>/server`, and the Runner Gateway `schema` and
`validator`.

To add a top-level contract, create `openapi/<id>/openapi.yaml`, add one
`contractEntries` entry, and run `make contracts-generate`. No Makefile or
test edit is needed.

JSON Schema and AsyncAPI directories are introduced only when a second real
protocol needs them.
