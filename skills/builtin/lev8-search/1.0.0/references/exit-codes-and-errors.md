# Exit codes and errors

| Exit | Meaning |
| --- | --- |
| 0 | Success. Check `completed`; partial results are marked by `meta.partial`. |
| 1 | Business failure, possibly with partial data. |
| 2 | Invalid input, receipt, or key conflict. |
| 3 | Token, authentication, permission, or keyring failure. |
| 4 | Credits or concurrency limit reached. |
| 5 | Timeout, transport failure, or unknown state. |
| 6 | Local persistence or output failure. |
| 7 | Device authorization pending. |
| 130 | Local interruption. The server request was not cancelled. |

A nonzero exit does not by itself prove that no billing occurred. Report observed completion, partial results, costs if known, and unresolved state separately.

## Error actions

- `result_unknown=true`: preserve the receipt and report the uncertainty. Do not replace the key.
- `retry_with_new_key=true`: a new paid attempt is confirmed safe, but the user must still authorize it.
- `concurrency_limit` on synchronous contact or Entity: retry later with the original key.
- `authorization_pending` (exit 7): run `auth device complete --id <id>` again later.
- `credential_exists`, `credential_shadowed`, `device_flow_unsupported`, `device_exchange_unknown`, `authorization_consumed`, `invalid_device_code`, `api_access_required`: see [auth-and-config.md](auth-and-config.md).
- Receipt, resume and cancellation errors: see [receipts-and-recovery.md](receipts-and-recovery.md).
- Error code `invalid_arguments` (exit 2) also covers an invalid `--stdout-limit` or `LEV8_STDOUT_LIMIT`.
