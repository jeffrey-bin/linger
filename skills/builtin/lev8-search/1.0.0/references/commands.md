# Commands

Run `lev8 <command> --help` for current flags. Help shows only the global flags a command actually uses.

## Contact search

```sh
lev8 contact search --type email --objective 'person and company with identifying evidence' --json --stdout-limit 16384
```

- Email explicitly defaults to lightweight mode. Phone uses `--type phone` and always sends `lightweight=false`.
- `--work-timeout` is the server work budget; `--wait-timeout` bounds client waiting.
- Preserve returned references, owner match and reliability evidence. Do not treat a found address as verified ownership or invent missing evidence.
- `not_found` is a successful empty result. `outcome=error` is a business failure even if the HTTP status was 200.

## Contact batch

- Pass an objectives JSON array through `--input <file>` or `--input -`.
- Use `contact batch start --wait` when delivery must be completed.
- A batch is terminal at `status=completed` even if pending items remain. Preserve indices and report `meta.partial`, pending and failed counts.

## Entity search

```sh
lev8 entity search --type person --objective '...' --limit 20 --wait --json --stdout-limit 16384
```

- `--wait` fetches all prepared pages in requests of up to 100 entities.
- An Entity terminal error may still include useful prepared results. Retain them and report the failure.
- Final data fields: `object`, `leads_search_id`, `status`, `ready_count`, `entities`. Also `verified_count` when reported and `stop_reason` when non-empty. The upstream error text is not included; an `error` phase is shown by exit 1 and `partial=true`.
- The raw upstream status object (`task_status`) is no longer embedded. Use `entity status <task-id>` for the raw status.
- `entity status <task-id>` reads status without creating work. `entity fetch <task-id> --pts 0 --num 20` reads one page (num 1..500, default 20).

## Synchronous research, enrichment and extraction

```sh
lev8 deep-search --query 'research question' --json --stdout-limit 16384
lev8 enrich --entity-context 'known entity facts' --schema fields.schema.json --json --stdout-limit 16384
lev8 extract --type github_repo_stargazers --target owner/repository --limit 10000 --json --output rows.json
lev8 extract --type web2list --target https://example.com/directory --instruction 'extract company names and websites' --json --stdout-limit 16384
```

- Enrich accepts a non-empty object JSON Schema file, or `--schema -` for stdin.
- Extract types and limits are listed in help. web2list requires a public HTTP(S) URL and an instruction, and normalizes limit to 100.
- These are billed synchronous POSTs. All have a default HTTP budget of 10m15s, so Enrich is not tied to one environment's shorter execution limit.
- `--wait` keeps replaying an in-progress receipt. Its total budget includes the initial POST.
- `--http-timeout` overrides the client budget only. The CLI does not discover server execution limits.
- Extract accepts up to 64 MiB of response JSON. Responses are buffered within that limit, not streamed. Use `--output` for large results.

## Output

For Runtime business commands, use `--stdout-limit 16384` as in the examples. This is below native Bash output transfer limits; the CLI default remains 65536. If a native tool returns its own saved-output path instead of complete stdout, read that full file before interpreting the JSON.

- With `--output`, read the full result from `meta.output_path`. Stdout is a brief receipt with `data=null`.
- Without `--output`, a result whose compact JSON exceeds `--stdout-limit` bytes is saved automatically. The default is 65536. `LEV8_STDOUT_LIMIT` sets it, `0` disables it, and the flag overrides the variable. Invalid values exit 2 with `invalid_arguments`.
- Automatic files go to `<receipt directory>/outputs/<receipt-id>.json`, or to a random name when the operation has no receipt. They are 0600 in a 0700 directory. Their content is the same result as `--output` but compact on one line, while `--output` files are indented.
- Stdout then has `data=null`, `meta.output_path`, `meta.output_auto=true`, `meta.output_bytes`, and `meta.output_summary`. The summary maps each top-level array in `data` to its length, for example `{"entities":500}`; it is omitted when there are none.
- If the file cannot be written, the full result is printed to stdout and `meta.output_spill_error` gives the error code. The exit code is unchanged.
- Failures that carry data (such as partial results) can spill too. Errors without data are small and never spill.
- Without `--json`, the output is a human summary. An automatic save prints `Result saved to <path> (<bytes> bytes; ...)`. The `Completed:` status line appears only when the request was sent and the outcome is not a clean success.
- `--json` stdout is one compact line of JSON followed by a newline. `--output` files are indented for reading; automatic files are compact.

## Quick reference

- Global flags: `--json`, `--output`, `--stdout-limit`, `--api-base-url`, `--config`, `--allow-http`, `--http-timeout`. Waiting flags `--wait`, `--wait-timeout` and `--poll-interval` apply to commands that wait.
