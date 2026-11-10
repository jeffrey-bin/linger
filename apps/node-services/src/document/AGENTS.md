# Document Runtime Role Conventions

## Boundary

- This role is the Node Document Runtime boundary inside `node-services`. It owns Hocuspocus WebSocket handling, resident Y.Doc state,
  awareness, mutation preflight, deterministic Yjs/BlockNote computation, and
  the online body of every native Document.
- It saves every edit of a native Document's `document_bodies` row in
  TeamHub's database, which it reaches through `TEAMHUB_DATABASE_URL` with
  TeamHub's privileges; TeamHub owns the migrations, inserts the row when it
  creates a Document, and clears the editors at a History point. The role's
  statements update only `document_bodies` and read only `documents`,
  `document_permission_counts`, `document_bodies`, `document_assets`,
  `document_revisions` and `room_document_comment_threads`. What they set off writes more:
  `record_document_history_point` inserts and updates `document_revisions`,
  queues a `document_text.sync` row in `river_job` and publishes a realtime
  wake, and the `document_bodies` trigger updates
  `room_document_comment_threads` and queues a `document.comment_input` row
  in `river_job` for each queued comment Run of a Thread it attaches or
  orphans; for those Threads it also writes a Document Event and, in each
  bound Room, a `document.comment.changed` Room Event, taking the Room rows
  then the Document event lock. `bodies.ts` is the only module that opens
  the database; `tests/document/database-boundary.test.ts` enforces this.
- It has no permission policy, lifecycle authority, Job, Outbox or Artifact
  ownership; it decides only the idle and continuous-editing History points.
  On start it records the idle points that a stopped Runtime left for bodies
  that still carry editors, because a History point also queues the body's
  text. It exposes TeamHub-callable operations only through the
  generated `@linger/wire-contracts/node-services-internal/server` export
  and calls no TeamHub endpoint.

## Structure

- `main.ts` is the host-facing role: it starts `worker.ts` on its own worker
  thread, because the runtime installs jsdom globals and replaces the global
  `Request`/`Response`, which must not reach the other roles. A thread error
  or unrequested exit rebuilds the thread with 1 s to 60 s backoff, so the
  Document Runtime never stops the process. At startup only a configuration
  `TypeError` fails the role; other startup errors, such as a busy port, retry
  in the background while the other roles start.
- `worker.ts` reads the configuration, starts the server, and drains once when
  the host asks, replying with the drain status. It must not register signal
  handlers or call `process.exit`.
- Construct the Hono app in `app.ts` so HTTP behavior remains testable without
  opening a port.
- Colocate behavior and tests by the public interface they exercise. Introduce
  subdirectories only when that feature contains real behavior; do not add
  export-only feature barrels.
- Health and readiness are both process liveness: the Runtime holds no lease,
  event cursor or fence that TeamHub waits on.
- A connection authenticates once, in `onAuthenticate`: the
  Runtime verifies the HMAC connection token TeamHub signed with the key both
  derive from `LINGER_SECRET_SEED` (label `document-connection-token`), then
  loads the body and the Document's permission count in one statement and
  refuses the connection when the count differs from the token's or the
  Document is not an active native Document. A failed load is retried once
  inside the admission window. It logs `document.connection_authenticated`,
  `document.connection_token_stale` and `document.body_load_retry`.
- Frames read nothing from the database, except that a frame adding an Asset
  or Comment Thread reference the Document has not had before checks it once,
  within the frame's authorization deadline.
- A save is one `UPDATE document_bodies` on the base sequence; the durable ACK
  (the browser's Saved state) is sent only after it returns. A save that
  updates nothing reads the row once: a newer sequence is a stale base, so the
  Runtime loads the newer body and applies it to the resident Y.Doc
  (`onNewerBody`), the same state at the next
  sequence is this save whose reply was lost, and anything else fails the
  queue with `append_rejected`. A connection error is retried with backoff
  (`document.body_save_retry`). A save appends its editors to
  `last_editor_ids`, the batch's last author last.
- `bodies.ts` records History points of editor saves (`historyPoints: true`)
  with `record_document_history_point`, which copies the body row into a
  Revision: an idle point 30 s after the last save, by a timer that first
  checks the row's `updated_at`, and a continuous-editing point on the first
  save 5 minutes after the latest point, in that save's transaction. It keeps
  each Document's latest point time in memory only to choose between the
  single UPDATE and that transaction; the database checks the rule again. A
  body loaded with edits after its latest point arms the idle timer for the
  rest of the idle time. Server changes save with `historyPoints: false`;
  TeamHub records their point. A timer failure logs
  `document.history_point_retry` and retries after the idle time.
- TeamHub's server changes arrive as `applyDocumentChange` (`semantic`,
  `restore` or `comment_anchor`). `document-changes.ts` runs each
  under the Document's mutation order: it computes on the resident Y.Doc, or
  the loaded body when the Document is not open, saves it with the same
  sequence-checked UPDATE, retries a stale save on the newer body, and then
  applies the update to the resident Y.Doc and broadcasts it. The save appends
  the change's `operation_id` to the body's `server_operations` (the latest
  32); a change whose ID is already there returns the sequence and title it
  saved without applying it again, so TeamHub's retry after a lost commit is
  idempotent. A behind
  `expected_seq` is a `stale_head` conflict. `importDocument` and
  `exportDocument` only compute and touch no database.
- Connections are limited per token session (4) and in total (1,000); there
  is no per-Actor limit.
- TeamHub commits a trash or permission change first and then calls
  `disconnectDocumentConnections`: the Runtime closes the
  Document's connections, or one Actor's, with `1000 / Document access
changed`, and each client reconnects with a fresh token. The Runtime counts
  disconnects per Document and per Document and Actor; a connection whose
  open read the permission count before a disconnect is closed when it joins,
  and its frames and durable ACKs are refused. A failed call only leaves
  connections open until their tokens expire.
- Session limits are the constants in `@linger/document-model`
  (`ROOM_DOCUMENT_SESSION_LIMITS`). TeamHub keeps its own copy of the state
  bundle limit (`BundleDecodedBytesLimit`) only to check the bodies it
  inserts, because `importDocument` does not check it.

## Verification

- Run `pnpm --filter @linger/node-services check` for this boundary.
  `tests/document` runs as the Vitest `document` project, one file at a time
  after the other roles' tests; use `--project document` for a focused run.
- Realtime tests use public WebSocket and internal HTTP interfaces and never
  inspect a private resident-document map. They run against
  `MemoryDocumentBodies` (`tests/document/realtime-test-support.ts`), which
  applies saves with the table's sequence check; `bodies.test.ts` covers the
  SQL store's statements.
- `tests/document/realtime-latency-probe.ts` is a manual probe outside CI: it
  types into 1 MiB and 8 MiB Documents through the real Runtime and prints
  frame and `/readyz` latency percentiles. Run it before and after a change to
  the per-frame path.

## Computation threads

- TeamHub-callable computation endpoints run document-model functions on a
  `node:worker_threads` pool (`computation-pool.ts`, worker in
  `computation-worker.ts`) nested in the role's thread.
  The pool size is a built-in constant (1), so a
  CPU-bound batch never stalls realtime or HTTP health on the role's thread.
- The role's thread keeps HTTP parsing, validation, hashing, `stateVectorFor`,
  base64/JSON encoding and error mapping. Realtime preflight, session and
  durability computation stay on that thread; `createDocumentRealtimeServer`
  installs the DOM shim it needs instead of relying on the host process.
- Coded document-model errors cross the thread boundary as
  `DocumentComputationError` with the same `code`, so endpoint status mapping
  is unchanged. Inputs and results are structured-cloned; do not transfer
  Node Buffers.
- Workers start on demand when work is queued and exit after 5 minutes idle,
  so an unused Runtime holds no extra isolate. An idle exit is logged at info
  and is not a failure.
- A crashed worker fails only its in-flight request (500). A replacement
  starts only for queued work and no sooner than 1s after the failure, so a
  worker that keeps failing to load cannot spin the CPU or flood logs. Queued
  work is not capped.

## Permanent-save failure evidence

- Permanent failure sends `durability_failure` to all recipients, drains their
  admitted frames, then closes with `1000 / Document durable save failed`.
  Failed queues reject writes and new sessions until unload. An unloaded
  Document reopens from its saved body in the same process.
- Before failed-queue release, capture a JSON file under
  `<AGENT_HOME>/document-runtime/failure-evidence`.
  Startup creates a `0700` directory. Files use `0600` and are named
  `<document_id>-<failure_at_iso>.json`. A directory-wide 256 MiB budget evicts oldest files first.
- Fields: `document_id`, `failure_code`, `failure_at`, `released_at`, complete
  `head` (`DocumentDurableHead`), `pending`, `pending_bytes`,
  `runtime_instance_id`. Each pending entry has `kind`, `actor_id`,
  `update_base64`, `update_bytes`. Timestamps are ISO UTC; sizes count raw bytes.
  `released_at` is the capture time.
- Evidence contains client update bytes. Structured logs contain only IDs,
  codes, times, counts, sizes, persisted sequence and the path or write error.
  `document_failed_queues` logs current failed queue count and bytes on changes.
  Evidence failures log an error and do not block release.
- Evidence supplements client Y.Doc/IndexedDB; committed Outbox updates already
  live in the body. This process has no evidence replay tool. Files are ephemeral
  with the Pod unless operators provision storage and set the directory.
  Fatal event-loop restart, total resident byte budgeting and shutdown drain
  redesign are separate work.
