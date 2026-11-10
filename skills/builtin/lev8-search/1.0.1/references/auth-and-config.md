# Authentication and configuration

## Device login details

- `auth device start` writes the approval link, user code and expiry. Its `data` depends on status:
  - pending: `authorization_id`, `status`, `verification_uri`, `verification_uri_complete`, `user_code`, `expires_at`.
  - authorized: `authorization_id`, `status`, `source` (`keyring` or `config`), masked `token`, `completed_at`, and `config_path` for file storage.
  - other terminal states: `authorization_id` and `status` only. The recovery guidance is in `error`.
  - Links and codes are removed once the attempt is no longer pending, so a stale link is never shown.
- Without `--json`, `start` prints `Open`, `Code`, `Expires` and `After approval: lev8 auth device complete --id <authorization_id>`. `complete` prints where the key was saved and the masked key.
- `complete --id` is recommended. Without `--id`, a single-user setup reads the local attempt, but several agents sharing one config directory must pass the ID to avoid completing another agent's attempt.

`complete` waits at most 30 seconds by default. Exit 7 with `authorization_pending` means call it again later with the same ID; `slow_down` is handled internally. A saved authorized result can be read again without exchanging another key.

- `authorization_replaced`: another start replaced this attempt.
- `authorization_expired` or `authorization_denied`: the attempt is finished; run a fresh start.
- `device_exchange_unknown`: retry `complete` with the same ID first. If that returns `authorization_consumed`, a key may already exist in the Web API Key list: have the user revoke the unreceived key before starting again.
- `invalid_device_code`: terminal. Have the user check the Web API Key list and revoke any unreceived key before starting again.
- `api_access_required`: the user must restore API access.
- `credential_exists`: replacing the credential needs an explicit user decision, `--force`, and revoking the old key in Web. Do not add `--force` automatically.
- `credential_shadowed`: remove the environment credential or select the correct file storage.

## Other login paths

- Cloud Host never supplies or forwards a deployment credential. An environment credential there is a deployment misconfiguration; report it instead of saving a shadowed replacement. On Local Computer, users may run `lev8 auth login` themselves in their own terminal; never ask for a key in chat.
- `device_flow_unsupported` means the server lacks device flow or the API address/routing is wrong. Have the user check it and explain the available secure login path without asking for the key in chat.
- Auto storage: explicit `--config`, `LEV8_CONFIG`, or an existing file token selects config storage. Otherwise login prefers the system keyring and falls back to a private config when saving to the keyring fails.
- `--storage config` explicitly selects the file; `--storage keyring` prohibits fallback.
- Explicit keyring login refuses an existing config token because it would shadow the saved credential.
- Both destinations save only the token, preserve existing file connection fields, and never persist transient flags, environment settings or defaults.
- Keep the intended API environment configured for later commands. Device completion uses the origin pinned by `start`.
- Never put tokens in command arguments, objectives, result files or progress messages. The private credential config is the only supported token file.

## Config file and precedence

- The default config is `<user config directory>/lev8/config.json`, alongside the default `lev8/requests` directory. `LEV8_CONFIG` or a higher-priority `--config` selects another path.
- Fields are `token`, `api_base_url` and `allow_http`. Each resolves independently: flags > environment > config > keyring (token only) > default.
- API flags override `LEV8_API_BASE_URL`. An empty `--api-base-url=` is an error.
- Non-loopback HTTP needs `--allow-http`, `LEV8_ALLOW_HTTP=1`, or config `allow_http=true`. Explicit `--allow-http=false` or environment `0` overrides lower-priority true.
- Unix config must be a regular file with owner-only permissions; default-path symlinks are rejected too. When dotfiles symlinks manage the config, point `--config` at the real private file.
- Login writes 0600 atomically and creates new directories as 0700.
- On Linux Host, `XDG_CONFIG_HOME` already selects the persistent per-Context command home. Do not set `LEV8_CONFIG` or `LEV8_STATE_DIR` to a service-wide path. Windows storage privacy depends on user-directory ACLs and remains experimental.
- Invalid config format, type or permissions must be reported to the user; do not rewrite fields or change permissions automatically.
- Prefer login over hand-writing credential JSON.

## Status and logout

- `auth logout` only removes the keyring entry and reports `keyring_token_removed`; environment and config tokens remain active.
- Status and logout can report invalid config as `config_valid=false` with `config_error`. Status uses `source=unresolved` and does not fall back to another credential.
- A null `config_token_active` means unknown, not absent.
- Status exit 0 means diagnostics completed, not successful server authentication.
- Do not switch a receipt to another token or origin.
