# Service Kit: Shared TypeScript service helpers

Small helpers shared by Web, Node services, and Voice Runtime.

## Common Commands

- `pnpm --filter @linger/service-kit check`: typecheck, lint, and test the package.

## Structure

- `src/index.ts`: isomorphic entry (`isRecord`, `isNodeError`, `asError`,
  `displayText`, `sleep`, fetch test-double text helpers). It must not import
  `node:` modules because the Web app bundles it.
- `src/node.ts`: Node-only entry (`sha256Hex`, `createJsonLogger`,
  `serviceCredential`). `serviceCredential` takes the environment from its
  caller and is checked against `contracts/fixtures/service-credentials/vectors.json`.
- `src/json-logger.ts`: one-JSON-line logger whose shape matches Agent's
  `AgentLogger`; keep the redaction rules aligned with
  `apps/node-services/src/agent/observability/agent-log.ts`.

## Important Conventions

- Add a helper here only when two or more apps need identical behavior; keep
  the package free of runtime dependencies and environment variables.
- The package is built into the Web image (`apps/web/Dockerfile`) and the
  node-services image (`apps/node-services/Dockerfile`, which also carries the
  voice runtime); a new consumer must add the package to that image's
  Dockerfile.
