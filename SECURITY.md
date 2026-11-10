# Security Policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
**Report a vulnerability** button on this repository's Security tab. Do not
open a public issue, pull request or discussion for a suspected vulnerability.

Include what you found, the commit or version you tested, and the steps to
reproduce it. We aim to acknowledge a report within three working days and to
agree on a disclosure date with you once a fix is ready.

## Supported versions

Only the latest commit on the default branch receives security fixes. There
are no maintained release branches yet.

## Trust model

Linger is a self-hosted workspace for one owner and the Agents that work
for them. Read these assumptions before you expose a deployment to a network.

- **Agents act with your authority on your computer.** An Agent runs Codex,
  Claude Code or Pi on a Local Computer you connect, with the access that
  Runtime has on that machine: your files, signed-in apps and shell. Connect
  only computers whose owner accepts that. Permission review
  (`TEAMHUB_PERMISSION_REVIEW`) asks a model to judge risky actions before
  they run; it reduces mistakes but is not a sandbox.
- **Agents read what their Human reads.** Every Document the owner can open is
  available to the owner's Agents. Sharing with an Agent only notifies it.
- **External apps write only after confirmation.** Reads through Connected
  apps run directly; writes such as sending mail wait for the owner's
  confirmation in the Room.
- **One secret protects every service link.** TeamHub, the Node services and
  the Voice Runtime derive their credentials from `LINGER_SECRET_SEED`.
  `TEAMHUB_SECRET_ENCRYPTION_KEY` encrypts API keys saved in the product.
  Anyone who holds either value can impersonate a service or read saved keys.

## Safe defaults

`.env.example` and `scripts/local-defaults.env` ship a public development seed
and encryption key so `pnpm dev` and `docker compose up` work on `localhost`
without setup. Everyone has these values. TeamHub refuses to start with the
public seed once `WEB_PUBLIC_ORIGIN` is not `localhost`, `127.0.0.1` or `::1`.
The Linger installer does not use the public values: it generates a private
seed and encryption key for each instance once, keeps them in the instance's
owner-only `services.env`, and preserves them across restarts and reinstalls.
Losing or replacing the encryption key makes a saved Composio key unreadable
until someone saves it again in Apps.

Before serving other computers:

- Generate private values with `openssl rand -base64 32` for
  `LINGER_SECRET_SEED` and `TEAMHUB_SECRET_ENCRYPTION_KEY`, and keep them in
  the ignored `.env` or your secret store, never in Git.
- Put HTTPS in front of the Web port. The Computer installer, the Runner
  Gateway WebSocket and sign-in cookies travel over that connection, and plain
  HTTP exposes them to anyone on the network.
- Change the PostgreSQL password from the development default and keep the
  database and the Node services' ports off public networks; only the
  Web port needs to be reachable.

The Vite development server (`pnpm dev`) is for one developer on one machine.
It binds to `127.0.0.1`; do not expose it to a network.
