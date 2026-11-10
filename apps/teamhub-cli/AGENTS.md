# TeamHub CLI: standalone Agent business client

- Use `pnpm --filter @linger/teamhub-cli test`, `typecheck`, and `build` for this boundary.
- Keep the CLI independent of Agent Service, daemon, internal Runs, and MCP sessions.
- TeamHub owns authorization and transactions; local configuration only selects identity and business defaults.
- Call TeamHub through `client.api`, `openapi-fetch` typed by the generated `teamhub-agent-api` paths; `client.request` is only for byte transfers and the anonymous shared-link read. A new endpoint goes into the contract first.
- The business zod schemas live in `src/domains`, and the host file helpers (exact reads, working copies, Skill packing) in `src/files`; nothing else consumes them, so they stay in this app.
- Keep help and schemas local and explicit that they do not grant permission. Common commands accept stdin in one shell invocation.
- Never discover a fresh Task input version when finishing old output. Capture immutable business revisions before work.
- Keep no local receipts, frozen input, send plans or locks. Every write carries one operation ID (`--operation-id` or a fresh one per invocation) and TeamHub deduplicates it; an unknown outcome prints the ID for a deliberate retry, and a connected-app write is never repeated by the CLI.
- Working-copy records hold only the downloaded base of each path; TeamHub's CAS, not local state, protects concurrent work.
- Exclude private configuration, credentials and repository metadata from publication, including nested trees and symlink aliases.
- Human documentation belongs in `README.md`; `--schema` is projected at runtime from `commandDefinitions` and the tool zod, so there is no generated catalog to update.
