---
name: teamhub-files
description: Create and edit Native TeamHub Documents, read any Document your Human reads, request edit access, download working copies, and deliver files through the authenticated TeamHub CLI.
---

# TeamHub Documents and file delivery

Use the installed `teamhub` CLI through the shell. Its configuration supplies the Agent identity and the current Room or Task; TeamHub checks current access on every request. Never read, log, copy or override credentials or invent resource identifiers. Help is offline and grants no permission.

## Current CLI contract

Use the simple body entry for ordinary messages and the complete message entry only when the message needs exact segment ordering or segment-specific fields:

```bash
teamhub message send --content "Please review the report." --json
teamhub message send --file ./playground/<scope-id>/body.md --json
teamhub message send --message '{"segments":[{"type":"text","content":"Please review the report."}]}' --json
teamhub message send --message-file ./playground/<scope-id>/message.json --json
```

`--content` is literal text and `--file` reads one UTF-8 body file; neither guesses a path, expands `@file`, or uploads Markdown image paths. The complete JSON object must contain only `segments`; each text or caption value is still named `content`. Put `--reply-to` outside that object. Use explicit Markdown Actor references such as `[@Researcher](agent:actor_researcher)` when the message should mention an Actor.

A message goes to the configured Room; add `--thread <thread-id>` for a Thread of that Room. The CLI has no Room or Task target flag. In a Task you don't send messages or create Documents: write files under `./playground/<task-id>/` and describe them in your final reply. Pass bare resource IDs. Default text and JSON errors identify the operation, target type, and bare ID, for example `Target: --thread thread_example`; they do not expose an internal `room:...` or `task:...` address unless the command explicitly accepted `--inbox`.

The proactive `request_human_interaction` CLI/backend route is retired. Do not generate it. Existing domain approvals, workflow checkpoints, the public Decision API, and historical interaction cards remain separate business capabilities.

## Create and edit

Create a Native Document with a literal Markdown body or a UTF-8 file:

```bash
teamhub docs create --title "Project notes" --content "# Project notes" --operation-id <unique-create-id> --json
teamhub docs create --title "Report" --file ./playground/<scope-id>/report.md --json
```

The Document is created in the configured Room. Use the returned `document_id` and `revision_id`. Small text-only creation accepts no local media references; deliver local media through message resources.

For a targeted change use one edit action per operation:

```bash
teamhub docs update <document-id> --command append --file ./playground/<scope-id>/addition.md --operation-id <unique-edit-id> --json
teamhub docs update <document-id> --command str_replace --pattern "Old exact text" --content "New text" --json
teamhub docs update <document-id> --command set_title --title "New title" --json
```

`str_replace` matches one exact, single-line occurrence and preserves the surrounding block identity. A missing or ambiguous match returns a conflict and changes nothing. Block insert, replace and delete require real stable block IDs from a blocks/HTML read. A range must use both endpoints in one contiguous sibling range. Do not guess anchors, use array indexes as IDs, or substitute a full-body replacement for a targeted edit. Inspect `teamhub docs update --help` or `--schema` for action-specific flags. Only `status: applied` confirms a change; preserve conflict reasons and observations.

## Read and request edit access

You read every Document your Human reads, without asking. Use `teamhub docs list --json` for those Documents with your role, editable flag, requestable roles and pending requests. Use `teamhub docs get <document-id> -o <local-path> --json` for current bytes. An exact name or supported share link may also be used; do not guess among same-title files.

Editing needs a grant. When `editable` is false and `requestable_roles` contains `editor`, ask for edit access:

```bash
teamhub docs request <document-id> --reason "I need to apply the requested correction." --json
```

The configured Room or Task is the request origin. Room requests post a card there; a Task's request posts it to the Room that delegated the Task, or to the Sponsor's direct chat when that Room is unavailable. A repeated pending request is reused; do not request again while waiting or paste an approval URL when TeamHub already posted the card. After approval, read again before editing the Document.

## Working copies and delivery

Native Markdown exports are read-only representations. For a full Native working-copy save, first download `--format blocks` or `--format html`, edit that tracked file, then use exactly the returned `teamhub docs replace <document-id> <working-copy-path>` command. It retains the original revision baseline. After a conflict, download to a different path and reconcile; do not overwrite concurrent edits or obtain a new baseline for old output. Ordinary file downloads have no Native save command.

Deliver a local file by attaching it to a visible message:

```bash
teamhub message send --content "The report is ready." --attach ./playground/<scope-id>/report.pdf --json
```

For ordered media, an existing Document, an inline fragment or a directory tree, use the complete message form:

```bash
teamhub message send --message-file ./playground/<scope-id>/message.json --json
```

The JSON object has `segments`. A local Document segment uses `{"type":"document","content-path":"./playground/<scope-id>/report.md","mode":"document"}`; use `mode: file` for ordinary bytes or `mode: tree` for a Room directory delivery. Publication and message commit are atomic. Preserve server-returned resource IDs and statuses; an unchanged resource is not a new publication. Publish a local Skill with `teamhub profile skill publish <folder>`, not file delivery.

Keep work below `./playground/<room-id>/`, `./playground/<task-id>/` or `./playground/<document-id>/`. In a Meta, `./playground/<task-id>/` is a delegated Task's live output folder: attach its files or a subdirectory, not the folder itself. Never include credential/configuration directories, repository metadata, symlinks into private data, or unrelated files in a delivery.

## Comments and recovery

Use `teamhub docs comment get <thread-id>`, `reply <thread-id> --content "Reply"`, or `replace <thread-id> --content "Replacement"`. A comment action authorizes through that Thread's Document; it does not grant Room authority. Replace selected text only when explicitly requested, and retain the returned observation if the selection conflicts.

`duplicate_request` reports whether TeamHub reused the original result. True includes a human-readable `reason`; false omits it. An operation ID is not CAS. After an unknown result, rerun the exact command with the same input and the operation ID the error printed; TeamHub returns the original result. Without `--operation-id` every run is a new write. Changed input under the same ID is rejected, not recovered. Never describe an uncertain result or a conflict as success.
