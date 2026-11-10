# LLM Wiki Role Conventions

## Purpose

- Generate Personal Wiki candidates for TeamHub:
  `POST /internal/v1/wiki-refreshes/{wikiRefreshId}/candidates` turns one
  admitted refresh's frozen source bytes and published base pages into a
  complete, validated Markdown page set.
- Normalize one document to Markdown at `POST /v0/document-normalizations`.
- Both routes mount on the process listener shared with the other roles and require the TeamHub service token.

## Constraints

- TeamHub owns admission, source selection, retries, settlement, and
  publication. Never select Documents, owners, or target pages, keep refresh
  state, or call back into TeamHub.
- Do not import TeamHub, Agent, Room, Sandbox, or product-client source code.
- Do not add an MCP transport or a query API to this role. Agents query
  knowledge through TeamHub and Memory.
- Run bounded Wiki model tasks on the owner’s Agent Runtime. Route candidate entities, write meeting and entity pages, and validate the complete candidate locally before returning it. Never spawn a model CLI or call a model API from the service.
- Render structured page proposals with the registered schema and generate directory indexes deterministically.
- Normalize sources only through the process's one `DocumentNormalizer`, which
  the host passes in; never construct another. A source that can never be
  normalized is left out of the generation.
- Send sources only under the run's `inputs/`, beside the entity registry;
  neither is ever applied to the candidate or published.
- A Session source arrives with its routing (`session`: date, Room, capture,
  transcript Document, the Human). Take its target page and citations only from
  that routing and the message metadata lines under message headings, never
  from other text in the Session. A Session page cites Room messages
  (`teamhub://rooms/<room>/messages/<message>`) or a recording's transcript
  Document version.
- Validate candidate pages by path, size, and SHA-256, and reject undeclared
  files, traversal, normalization collisions, symlinks, and special files. Check
  OKF frontmatter, registered node types, and evidence references before
  returning a candidate.
- An invalid candidate or a request too large for one invocation is terminal;
  an offline Computer, an unready Runtime, a timeout, or a normalization or
  infrastructure failure is retryable, and a generation stopped by this
  process's own shutdown answers `WIKI_SERVICE_STOPPING`.
- A model task that stalls twice, stays too large after its halvings, or does
  not start before the generation deadline is skipped with an ERROR log, never
  fails the refresh. Report the sources a failed task left unwritten, and
  those of pages validation restored or dropped, in `unsettled_sources`
  (TeamHub keeps them pending for at most three tries); report those left only
  because the deadline passed in `deferred_sources` (pending, no try spent).
- Read configuration only in `config.ts`. The Runtime uses its default model;
  the backend chooses the reasoning effort.
- Never log or persist credentials in prompts, generated output, diagnostics,
  or tests.
- Keep source document bodies and titles out of logs and test snapshots.

## Source Layout

- This directory is the `llm-wiki` role of `apps/node-services`. The package
  `package.json` owns its dependencies and scripts, and root `.env` and
  `.env.example` own runtime configuration; do not add role-local package or
  environment files.
- `service.ts` starts the role, `config.ts` reads its configuration, and
  `wiki-server.ts` mounts the routes.
- `wiki-refresh-candidates.ts` materializes a request (`wiki-session-source.ts`
  renders a Session's input and citations), `wiki-initialization.ts`
  bisects a rejected generation within its run and time budget and reports
  the sources it never ran as deferred,
  `agent-wiki-backend.ts` generates with the memory Agent (`src/memory-agent.ts`):
  routing over candidate entities, meeting Session pages, one consolidation
  call that merges the new entities parallel routing named more than once,
  entity pages written in batches, one correction round; `wiki-candidate-*.ts` validate and recover
  candidates. Room chats get no Session page.
- `actor-wiki/` holds the operation directory state and the candidate tree
  scan.
- The `openwiki` package stays a library dependency (OKF frontmatter, Mermaid
  and link helpers); never run its CLI.
- Prompts live in `apps/node-services/prompts/llm-wiki/`.
- Keep tests under `apps/node-services/tests/llm-wiki/`, mirroring the source
  feature directory when one exists. Tests import the owning source module
  directly.
- Do not add an export-only `index.ts` or pass-through backend modules.
