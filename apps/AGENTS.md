# Applications: Independently runnable process boundaries

Each directory under `apps/` owns one deployable process.

## Common Commands

- `pnpm --filter <package-name> typecheck`: typecheck one TypeScript app.
- `pnpm --filter <package-name> test`: test one TypeScript app.

## Structure

- Each app owns its entrypoints, runtime configuration, tests, and deployment files.
- Shared in-process behavior belongs in `packages/` only after a real second caller exists.

## Important Conventions

- Do not import source from another `apps/*` directory.
- Consume cross-process operations through generated modules from `contracts/`.
- Do not commit build output, logs, runtime state, or app-local `node_modules`.
