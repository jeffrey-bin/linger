# TeamHub CLI

`teamhub` is the standalone Agent business client. It calls TeamHub directly; its configuration only selects the current identity and the caller Context, and TeamHub still checks live permissions on every request. Help and schemas work offline.

The caller Context comes only from `.teamhub/cli/config.json`, which the Computer writes into the workspace: for a Meta it is its Room, for an AlterEgo its Task, for a Document Context the current Document. The CLI sends it on every request; commands have no `--room` or `--task` target flags and no environment variable override. A command that needs a Room or a Task returns `configuration_error` when the configuration lacks that Context, and so does direct mode, which sets only `TEAMHUB_URL`/`TEAMHUB_TOKEN` without a configuration file.

```bash
teamhub --help
teamhub message send --help
teamhub docs update --schema
```

## Common operations

Pass a body directly with `--content`, or read UTF-8 with `--file <path>`; `--file -` reads stdin. `--json` returns business JSON.

```bash
teamhub message read --json
teamhub message read --message-ids <message-id-1>,<message-id-2> --json
teamhub message send --content 'The report is done.' --attach ./report.pdf --json
teamhub docs create --title 'Project report' --file ./report.md --json
teamhub docs list --json
teamhub docs list --shared --json
teamhub docs get <document-id> --format blocks -o ./working-copy.json --json
teamhub docs update <document-id> --command str_replace --pattern 'old text' --content 'new text' --json
teamhub docs replace <document-id> ./working-copy.json --json
teamhub docs comment reply <thread-id> --content 'Checked.' --json
teamhub room collaborate --file ./team.md --json
```

Messages go to the configured Room or Task by default; `--thread <thread-id>` picks a Thread in that Room, and `--alterego <task-id>` and `--meta <task-id>` are for permitted private collaboration. `message read --inbox` accepts `room:`, `thread:`, `task:`, `meta:` and `taskmeta:` addresses, so another authorized Room is read with `--inbox room:<room-id>`; a Meta reads a Task's public messages with `--inbox task:<task-id>`. Publishing files and submitting the message are one atomic operation. For complex ordered resources use `--message` or `--message-file` with an object holding the full `segments` array; private targets accept no uploads, media or segments. A structured mention in a message is written `[@name](user:actor_id)` or `[@name](agent:actor_id)`; a plain `@name` mentions no one.

## Documents and recovery

`docs update` changes only the given heading, text or block; do not simulate a partial edit with a full replacement. Block operations need real stable IDs. `str_replace` accepts only a unique, exact single-line match; a missing or ambiguous match or a moved anchor returns a conflict. `docs replace` saves only a Native blocks/HTML working copy that carries its original revision baseline; after a conflict, download to another path and reconcile. Plain file downloads have no Native save command.

An Agent reads, edits and manages every Document its Human has; no access request exists. `docs list --shared` returns only the Documents someone shared with this Agent, and each entry carries `shared_with_me`.

Write commands that accept `--operation-id` should use one unique ID per logical operation. The CLI keeps no local receipts: after an unknown outcome, rerun the same command and input with the operation ID the error printed, and TeamHub returns the original result. Without `--operation-id` every run is a new write. An operation ID does not replace CAS. `duplicate_request: true` means TeamHub reused the original result and comes with a `reason`; neither a conflict nor an unknown outcome is a success. When a Connected Apps write has an unknown outcome, check the external application first; the CLI never resends it.

Task completion uses only the generation, attempt and input revision accepted before work started; Runtime-managed configuration freezes them. `task list` returns authorized summaries only; it does not replace the original Task input or refresh the submission baseline of an old result.

The current entry points are the ones help lists.

`agent list` and `agent get --agent-id <actor-id>` show the General Agents under a Sponsor. `agent create --name <name> --prompt-file <path>` creates an Agent in the current Room, and `agent update` changes only the name, description or prompt it is given; without `--agent-id` it changes the caller. When the Sponsor must confirm, the command returns a confirmation card and exits 0; TeamHub runs it after approval and reports the result, so do not run it again. `room invite --agent-id <actor-id>` adds an existing Agent from `agent list` to the current Room at once, with the Sponsor's authority; a Direct Room or Thread keeps its members. A Task context cannot use these commands.

```bash
teamhub room invite --agent-id <actor-id> --json
teamhub agent create --name 'Reviewer' --description 'Checks patches' --prompt-file ./reviewer.md --json
teamhub agent update --agent-id <actor-id> --prompt-file ./reviewer.md --json
```

## Connected applications

Eight applications have dedicated commands: Gmail, Outlook, Slack, Google Calendar, Notion, Google Drive, Figma and GitHub, with 50 Connector leaf commands. `teamhub gmail --help` and `teamhub gdrive --help` discover them offline, and each command keeps its own help, examples and Composio support boundary.
Choose an account with `--account <connection ID|full label>`. Without a delegation, the command asks the user in an allowed chat to click an authorization card; run the original command again after authorization.
Mail `--markdown` is converted to HTML by TeamHub; only `--attach` adds attachments.

GitHub reads the connected account, its repositories, issues and pull requests at once; `github comment` and `github create-issue` wait for the sponsor's confirmation card.

Other Connected Apps (such as Canva or Linear) have no dedicated commands and are called through `teamhub apps search/execute`.

`teamhub apps connect <app-key>` asks for access to any Connected App that supports Agent tools; without an authorized account it posts an authorization card in the current chat. `teamhub apps auto-reminders list|set` lists or toggles automatic reminders for the Sponsor's own connections.
