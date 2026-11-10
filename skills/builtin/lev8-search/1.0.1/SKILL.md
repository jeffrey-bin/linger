---
name: lev8-search
description: Use the lev8 CLI for contacts, entity searches, deep research, schema-based enrichment and social/GitHub/web extraction through Lev8 External API, recover interrupted requests with private receipts, and complete browser device login. Does not send emails or messages.
---

# lev8 CLI

## When to use

Use the examples directly for known commands; run `lev8 <command> --help` only for unfamiliar flags or a version mismatch. Prefer `--json` (stdout is one compact line) and read `ok`, `error` and `meta`; HTTP 200 or a task ID is not completed work.

## Availability

Cloud Host includes lev8 0.5.0 and supplies only CI connection defaults, never credentials. Local Computer uses the user's own CLI and API configuration (CLI default: production). If missing or older than 0.5.0, ask the user to install/upgrade; do not install it yourself or silently switch APIs.

## Credentials

- If credentials are missing, run `lev8 auth device start --name 'Linger' --storage config --json`. Send `data.verification_uri_complete` and `data.user_code` to the user to compare, and keep `data.authorization_id`. `data` depends on status: pending has approval details and `expires_at`; authorized has `source`, masked `token`, `completed_at` and `config_path` (file storage); terminal states have only ID and `status`, with guidance in `error`. No links remain after the attempt ends.
- Finish the turn while they approve, then run `lev8 auth device complete --id <authorization_id> --json`. It waits at most 30 seconds; exit 7 means run it again later with the same ID. Without `--json`, `start` prints the same essentials.
- The approving account becomes this Context's credential and billing account. Ask the requesting user to approve with their own account and only the link they requested. Opening the link never approves by itself. Never ask for an API key or put tokens in arguments, objectives, result files or progress messages.
- Other login paths, storage and config: [auth-and-config.md](references/auth-and-config.md).

## Running commands

Do not query or display credit balances or inspect billing tools. Follow the authorized search scope and never fan out queries to beat limits. Starting and resuming are different actions.

```sh
lev8 deep-search --query 'research question' --json --stdout-limit 16384
```

- Use `--stdout-limit 16384` for Runtime business commands so native tools do not turn larger inline JSON into a truncated preview before the CLI can return its own receipt.
- If the native tool still persists or clips stdout (including spill failures), read its complete result file before parsing; never restart the billed request.
- Small results stay inline: use their full `data` without a second file read. Read detailed references only for the operation or error you need.
- With `--output`, read the full result from `meta.output_path`; stdout is a brief receipt (`data=null`). Commands and fields: [commands.md](references/commands.md).
- Without `--output`, results over `--stdout-limit` bytes (default 65536; `LEV8_STDOUT_LIMIT`; `0` disables) are saved automatically. Read the complete result from `meta.output_path` before claiming to have used it; the summary is not the result. Stdout then carries `meta.output_path`, `meta.output_auto=true`, `meta.output_bytes` and `meta.output_summary`. If `meta.output_spill_error` is set, the full result is on stdout: use that result without rerunning a billed operation.
- Without `--json`, output is a human summary. Save long-term results with `--output`; upstream Entity retention is finite.

## Receipts and recovery

- Each billing POST saves a private receipt first. After a disconnect, timeout or interruption, take `meta.receipt_id` and run:

```sh
lev8 requests show <receipt-id> --json
lev8 requests resume <receipt-id> --wait --json --output result.json
```

- Never generate a new key for a missing response. Resume keeps the original origin, token, body and key; never switch a receipt's token or origin.
- If `meta.result_unknown=true`, preserve the record and report the uncertainty. Only `retry_with_new_key=true` makes a new paid attempt safe, and the user must still authorize it.
- Ctrl-C and waiting timeouts stop local waiting only. Only synchronous contact can be cancelled: `lev8 contact cancel --receipt <id> --wait --json`.
- Receipts hold full request bodies; `lev8 requests prune --older-than 30d` keeps active and unknown ones. Replay rules: [receipts-and-recovery.md](references/receipts-and-recovery.md).

## Exit codes

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | Success | Check `completed`; `not_found` is valid |
| 1 | Business failure, maybe partial | Keep partial data; `outcome=error` fails at HTTP 200 |
| 2 | Invalid input, receipt or key conflict | Fix input; never change the key silently |
| 3 | Token, auth or keyring failure | Ask the user; `credential_exists` needs their choice |
| 4 | Credits or concurrency limit | Check `retry_with_new_key` |
| 5 | Timeout, transport or unknown state | Keep the receipt; resume with the same key |
| 6 | Local persistence or output failure | Check `request_sent` and the receipt |
| 7 | Device authorization pending | Run `auth device complete --id` later |
| 130 | Local interruption | Server not cancelled; resume the receipt |

A nonzero exit does not prove no billing occurred; report completion, partial results, known costs and unresolved state separately. Details: [exit-codes-and-errors.md](references/exit-codes-and-errors.md).
