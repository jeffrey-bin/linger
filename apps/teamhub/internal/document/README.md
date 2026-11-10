# Document module layout

- `service.go`: use-case entry of the unified Document aggregate. It exposes only domain inputs and outputs, never HTTP or generated contract types.
- `queries.go`: module-private PostgreSQL queries and row scanning. An authorization query must run in the same database snapshot as the resource read.
- The Space's one Human reads, writes and manages every active Document; a Wiki page is read-only. The SQL functions `resolve_human_document_access_v2` and `resolve_human_document_access_expiry` state that rule for one Document; list and search queries need only `document.status='active'`, and `human_document_access_test.go` keeps them aligned. An Agent has its Human's access to every Document, so Bindings and direct shares grant it nothing and a comment @Agent needs no authorization step.
- `runtime.go`: `Runtime`, the only interface through which the Service calls the Document Runtime. Without a configured Runtime these operations return `ErrRuntimeUnavailable`.
- `ids.go`, `retry.go`: stable IDs, digests and transaction retry decisions shared by the features.
- Markdown import parsing and rendering, and the media rewrite for portable downloads, live in `markdown_import.go` and `markdown_portable.go`. They are pure functions with no SQL, transactions or permissions; `markdown.go` maps their errors to the Service's errors.
- `service_test.go`: database-free unit tests of inputs, paging and capability combinations.
- Database behavior tests live in `apps/teamhub/tests/integration` and use a real PostgreSQL; this directory does not mock domain constraints.
- State machines, identity and cross-table evidence rules run in the Go write path inside one transaction: CAS (`UPDATE ... WHERE status=...` with a `RowsAffected` check) or a `FOR UPDATE` row lock with an explicit state check. Database triggers are not a fallback for these rules.

Extend the existing Service for a new capability; split a file only for an independent lifecycle or an external port. When deleting a feature, delete the queries and types that lose their callers.

## Server changes

A server change to a native Document's body (an Agent semantic edit, a History restore, a read-only commenter's
selection anchor) is authorized here and applied by the Document Runtime's `applyDocumentChange` in the same request. The change's transaction holds the Document's advisory lock and the caller's credential row while the
Runtime computes, saves `document_bodies` and broadcasts; it then records the History point and saves the replay in
`command_replays`. Nothing is queued, and there is no outbox or computation ledger: a
Runtime failure fails the request, which the caller retries with the same idempotency key. A retry after a lost
commit may apply the change again. New Documents (create, upload, duplicate, Agent create) get their initial state
from `importDocument` before their rows are inserted, and exports read `exportDocument`. Wiki pages are read-only
Markdown files and have no body.

## Document texts

`document_texts` holds each active Document's current version normalized once: the Markdown, its
SHA-256 and the plain search words, with the version it came from (`native_body` sequence or `file_version`).
`internal/documenttext` runs the one `document_text.sync` job; `enqueue_document_text_sync` queues it from
triggers on `documents` (a new current Version, reactivation), on a new `document_bodies` row and in
`record_document_history_point`. Global search and Memory (`memory_source.personal_documents`, through
`document_text_heads`) read it; the job skips a file Version whose text is already ready. A ready text requests no
Wiki refresh. The Wiki reads only the bound Documents its
whitelist admits: `wiki_document_verdicts` gives each one with a text a reason to stay out or none, using the text's
`scanned` and `longest_line_bytes` facts, and a refresh freezes the admitted ones by `document_text_version_id`.
Mail the whitelist filters out never becomes a source and is not recorded.
The Wiki's Session sources are not Documents: `wiki_session_sources` reads the Human's Room and recording Sessions
from the Memory index (`memory_index.sources` at their `source_versions` text), `wiki_current_sources` joins them
to the bound Documents, and a refresh freezes each Session at the SHA-256 of its indexed text.

Memory requests every Wiki refresh through `RequestMemoryWikiRefresh`; TeamHub requests none itself. The nightly
refresh (no capture ID) admits every changed source, in batches when they exceed one request; a batch that defers
sources sets `sources_deferred`, and its settlement queues `document.wiki_refresh_followup` for the next one. A
meeting refresh (`capture_id`) freezes that recording's Sessions at their current version and every published
source at its published version, and its settlement queues nothing. A refresh running when a request arrives
answers `in_progress`: a nightly request sets `followup_requested`, so the refresh's settlement, failure or conflict
queues a follow-up over every changed source; a meeting request is not admitted and is sent again. The dispatcher
reads text and metadata only for the sources a refresh adds or changes, so a source frozen at its published version
needs neither.

## History points

A History point is a Revision with a `history_trigger`, so a History Entry's ID is its Revision's ID.
`record_document_history_point` copies the body into a Revision (or marks the snapshot already holding that sequence),
credits the body's editors since the previous point and wakes open History views. The Document Runtime records the
idle and continuous-editing points of editor saves; `recordHistoryPointTx` records manual checkpoints, Agent edits,
restores and Wiki refresh results. There is no capture sweep.

## Retention

The sweep in `retention.go` starts a pass every hour and handles one Document per transaction: it deletes the
snapshots that a later History point covers and nothing references. The Revision delete guard only lets rows through
when the transaction sets `teamhub.document_retention=on`. When adding a foreign key to `document_revisions`, add it
to `deleteReleasedRevisionsSQL`.

The same hourly job then runs `wiki_version_retention.go`: an active Wiki page keeps its newest five Versions and a
page a refresh removed keeps only its current Version. A Version that another record still names (the current
Version, published or frozen refresh sources, Wiki source items, comment anchors, captures) is kept; the oldest kept
Version loses its `base_version_id`, and stored content no other row names is deleted. The Version guard allows that
delete and that base change only under `teamhub.document_retention=on`. When adding a column that points at
`document_versions`, add it to `prunableWikiVersionsSQL`.

Migrations are forward-only: Down raises.
