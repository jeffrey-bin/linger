# Receipts and recovery

## Receipts

- Before every billing POST the CLI saves a private receipt. If the receipt cannot be saved, the POST is not sent.
- The receipt directory is `LEV8_STATE_DIR`, or `<user config directory>/lev8/requests` by default. Directories are 0700 and files 0600.
- Receipts contain full objectives and request bodies. Treat them as sensitive and apply a retention policy.
- `lev8 requests prune --older-than 30d` removes old terminal receipts. It preserves active and unknown receipts and skips locked records. `--include-unknown` deliberately discards recovery records.
- Prune also removes automatic output files in `outputs/` older than the same cutoff, and reports `outputs_removed` and `outputs_skipped`. Symlinks are never followed or removed.
- Upstream Entity retention is finite. Save long-term results with `--output`.

## Resume

- Resume preserves the original origin, token fingerprint, exact body and idempotency key. Never generate a new key merely because a response is missing.
- Synchronous contact and Entity concurrency rejection can reuse the original key. A batch concurrency rejection requires a new key. Batch insufficient credits can reuse the same key.
- Deep Search, Enrich and Extract resume by replaying the original POST, with no extra GET. `request_in_progress` means known accepted work. `request_already_exists` means a failed zero-charge ledger and permits a new key.
- The server reconciles uncertain upstream execution using its original `client_request_id`.
- HTTP 200 with `success=false` is a known terminal business failure; preserve its result.
- A concurrency rejection during reconciliation does not settle the old request. Keep the previous unknown state and the original key.
- The server's request ledger is authoritative. Receipts are not a local billing ledger.
- `result_unknown` describes uncertainty about execution or charging, not unfinished work. A running request with a known server ID is not unknown.
- A failed observation (auth, network or 503 during resume) preserves earlier billing knowledge and completion. Even a 401/403 on a later resume does not clear an earlier `result_unknown`.
- A ledger read that confirms completion stays completed even if re-fetching the result body fails afterwards.

## Interruption and cancellation

- Ctrl-C and waiting timeout stop local waiting only. The server request is not cancelled.
- To request cancellation of a synchronous contact search: `lev8 contact cancel --receipt <id> --wait --json`. `cancel_requested` is provisional and keeps waiting; `cancelled` confirms cancellation; `already_terminal` is not proof of a refund.
- Deep Search, Enrich, Extract, Entity and batch commands have no public cancellation protocol. Stopping the CLI does not cancel server execution. If the first POST has no authoritative response yet, the receipt stays unknown until resumed with the original key.
- Batch `completed` is terminal even if `pending>0`; the result is kept and marked partial.
- Entity `error` still reads prepared pages and returns exit 1.
