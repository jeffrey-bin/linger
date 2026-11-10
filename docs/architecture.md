# Architecture

Agents run on the user's own computer, and the table follows each path in the
figure.

![An agent on the user's computer: the Computer Daemon brings messages and files from Rooms / Chat to the Runtime, which works in its Agent workspace, calls the LLM Gateway directly and talks to Rooms / Chat through the teamhub CLI, and every action passes the Guardrail before Cua, Playwright or the Shell carries it out](../assets/feature-local-computer.jpg)

| Path                                         | Carries                                           | How                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rooms / Chat → Computer Daemon → Runtime     | messages / files, model calls                     | The Computer Daemon dials out over one WebSocket, so the computer opens no port to the network; files land in the Agent workspace, checked by SHA-256. Background work such as Memory and the wiki runs as one-shot calls on the same Runtime |
| Runtime ↔ Agent workspace                    | read, write                                       | One per Context, that is one agent in one Room, Task or Document; `playground/` is writable, `memory/` and `llm-wiki/` are read-only                                                                                                          |
| Runtime → LLM Gateway                        | model calls                                       | The Runtime calls the LLM Gateway itself, local or remote; nothing passes through the Computer Daemon                                                                                                                                         |
| Runtime → teamhub CLI ↔ Rooms / Chat         | messages / files, tasks / routines / more actions | The CLI calls the server directly, and the server checks each call against the agent's current permissions                                                                                                                                    |
| Runtime → Guardrail → Cua, Playwright, Shell | click, type · browse · commands, as you           | Rule-based checks, then an LLM review; Cua, Playwright and the Shell then act as the user                                                                                                                                                     |

<sub>Pi runs without review.</sub>

## Inside Rooms / Chat

This opens up the figure's Rooms / Chat box; each line leaving it ends at the
figure box of the same name.

```text
┌─ Rooms / Chat ───────────────────────────────────────────────────────────────┐
│ ┌─ browser ────────────────────────────────────────────────────────────────┐ │
│ │ Web app: Rooms · Documents · Wiki · voice · search · settings            │ │
│ └───────────┬───────────────────────────┬───────────────────────────┬──────┘ │
│             │ Yjs WebSocket             │ HTTP + SSE                │ mic    │
│             ▼                           ▼                           ▼        │
│ ┌───────────┴─────────────┐     ┌───────┴───────┐            ┌──────┴──────┐ │
│ │ node-services           │     │ TeamHub       │ transcript │ Voice       │ │
│ │ Agent Service           │◀───▶│ Rooms, Docs,  │◀───────────│ Runtime     │ │
│ │ Document Runtime        │     │ permissions   │            │ LiveKit     │ │
│ │ Memory · LLM Wiki       │     │ PostgreSQL    │            │ Soniox ASR  │ │
│ └───┬───────────────────┬─┘     └───────┬───────┘            └─────────────┘ │
│     │                                   ▲                                    │
└─────┼───────────────────────────────────┼────────────────────────────────────┘
      │ messages / files, model calls     │ messages / files, tasks / routines
      ▼                                   ▼
Computer Daemon                      teamhub CLI
```

| Part            | Stack                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| Web app         | React 19 · Vite · React Router · TanStack Query · Tailwind CSS · BlockNote |
| TeamHub         | Go · Gin · PostgreSQL 17 · River job queue · goose migrations              |
| node-services   | Node.js 26 · Hono · Hocuspocus and Yjs                                     |
| Voice Runtime   | LiveKit Server · LiveKit Agents · Soniox streaming ASR · FFmpeg            |
| Computer Daemon | Go · SQLite · Playwright MCP · Cua                                         |
| Contracts       | OpenAPI, with generated Go and TypeScript code                             |

node-services supervises the Voice Runtime's ASR, recorder and Live workers and
ships them in its image; LiveKit Server runs as its own service in the root
`docker-compose.yml`.

## Inside the Computer Daemon

One background process per computer connects all of its agents to Rooms / Chat
and runs them.

```text
                               Rooms / Chat
                                     ▲
                                     │ one outbound WebSocket, shared by every
                                     │ agent on this computer
┌─ Computer Daemon ──────────────────┼─────────────────────────────────────────┐
│                                    ▼                                         │
│  command queues    one per Context, kept in order; 8 Contexts at a time      │
│  event ledger      SQLite; every event is saved before it is sent and        │
│                    replayed after a reconnect                                │
│ ──────────────────────────────────────────────────────────────────────────── │
│  Context views           Runtime adapters            local tools             │
│  files from the          Codex app-server ·          computer and browser    │
│  server, checked         Claude stream-json ·        MCP servers, one set    │
│  by SHA-256              Pi RPC; 8 parked each       per run                 │
└───────┬───────────────────────────┬───────────────────────────┬──────────────┘
        ▼                           ▼                           ▼
 Agent workspace                 Runtime                Cua · Playwright
```

<sub>Nothing on the computer listens on the network; local helpers use 127.0.0.1
or an owner-only socket.</sub>

## Inside the teamhub CLI

One command-line tool replaces per-tool MCP servers for Rooms, documents, tasks
and connected apps, and talks to the server directly.

```text
┌─ teamhub CLI ────────────────────────────────────────────────────────────────┐
│ 155 commands, one definition each: help, --schema and permissions follow     │
│                                                                              │
│ TeamHub      56 commands   message · docs · task · routine · room · agent ·  │
│                            knowledge · apps · tracking-items · profiles      │
│ Connectors   99 commands   gmail · outlook · teams · slack · gcal · notion · │
│                            gdrive · onedrive · figma · gitlab · gsheets · …  │
└──────┬───────────────────────────────────────────────────────────────────────┘
       │ HTTPS, with a per-agent token
       ▼
Rooms / Chat   checks identity, membership and capability on every call
       │ connector commands
       ▼
Composio       holds the app keys; an approved write runs exactly once
```

| Concern                    | How                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| One definition per command | Help, `--schema` and the permission manifest are generated from the same list                                              |
| Identity                   | A per-agent token, renewed over the Computer Daemon's link before its 48 hours run out and read from a file on every call  |
| No run required            | Works without an active run or the Computer Daemon, so an external agent with its own token can use it too                 |
| Approval                   | Sending mail or messages and writing to GitLab, Notion, Sheets or Airtable wait for a card in the Room                     |
| Retries                    | Every write carries an operation ID; a retry returns the stored result, and an unknown outcome is reported, not sent again |
| Files                      | Uploads and downloads are checked by SHA-256, and a download never overwrites a local file                                 |

<sub>Agents learn the CLI from the system prompt, five built-in Skills and layered
`--help`.</sub>

## Inside Cua, Playwright and Shell

Desktop and browser actions share one input slot and a log written before each
action, so two agents never fight over the screen and an uncertain input is
never sent twice.

```text
┌─ Cua · Playwright · Shell ───────────────────────────────────────────────────┐
│ ┌──────────────────────┐ ┌────────────────────────────┐ ┌──────────────────┐ │
│ │ Cua                  │ │ Playwright                 │ │ Shell            │ │
│ │ reads app windows    │ │ own Chrome profile per     │ │ the Runtime's    │ │
│ │ as elements, then    │ │ agent, or your signed-in   │ │ own command      │ │
│ │ clicks, types, drags │ │ Chrome, one task at a time │ │ tool, run in     │ │
│ └──────────┬───────────┘ └─────────────┬──────────────┘ │ the Agent        │ │
│ ┌──────────┴───────────────────────────┴──────────────┐ │ workspace with   │ │
│ │ one input slot: a second task waits for the screen  │ │ your account     │ │
│ │ each input is logged before it runs; an unknown     │ │                  │ │
│ │ result blocks further input and is never replayed   │ │                  │ │
│ └─────────────────────────────────────────────────────┘ └──────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

<sub>On Linux, AT-SPI and xdotool replace Cua, and only the agent's own Chrome
profile is used. Page scripts are not offered to agents.</sub>
