# Local Computer

The Local Computer is the resident Daemon on a user's machine, its
`linger-computer` control CLI, the outbound Runner Gateway transport, and the
workspace grants. Both programs are Go binaries built from `local-daemon/`; the
release bundle also ships a pinned Node runtime for the `teamhub` CLI and the
managed Computer tools.

## Install

Install from the Computers page of the Linger Web app, or run the installer
the Web origin serves. On macOS and Linux:

```bash
curl -fsSL "http://localhost:3000/install/linger-computer.sh" | bash
linger-computer login
```

On Windows, in an ordinary (non-elevated) PowerShell:

```powershell
irm "http://localhost:3000/install/linger-computer.ps1" | iex
linger-computer login
```

`linger-computer login` authorizes the computer in the browser and starts the
Daemon. A server connection token from the Web app works too:
`linger-computer login --token-stdin`. Then use `linger-computer daemon status`,
`linger-computer runtime check <codex|claude|pi>`, and `linger-computer doctor`;
`linger-computer --help` lists every command.

Conventions and boundaries are in [AGENTS.md](./AGENTS.md).
