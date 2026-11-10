package computercli

import "strings"

const runtimePathOptions = `  --codex-path <path>          Use this Codex executable
  --claude-path <path>         Use this Claude Code executable
  --pi-path <path>             Use this Pi executable`

const configOption = `  --config <path>              Use another Computer config file`

var commandHelp = map[string]string{
	"login": `Usage:
  linger-computer login [options]

Authorize this computer in your browser, save its credential, and start the
daemon. When it finishes, the computer is connected.

Options:
  --web-url <origin>           Linger site to sign in to
  --name <name>                Computer name (default: host name)
  --enabled-runtime <type>     Enable only this Runtime; repeat for a subset (default: all)
  --token-stdin                Read the server connection token from standard input (hidden prompt in a terminal)
  --gateway-url <wss-url>      Override the Gateway URL
  --max-concurrent-runs <n>    Limit concurrent runs (1-100)
  --no-max-concurrent-runs     Remove the concurrent run limit
  --codex-auth <path>          Use this Codex auth.json
` + runtimePathOptions + "\n" + configOption + "\n",
	"auth": `Usage:
  linger-computer auth status [--json]

Commands:
  status                       Show the site, Computer, and authorization saved on this computer
`,
	"auth status": `Usage:
  linger-computer auth status [--json] [--config <path>]

Show the site, Computer, workspace, and Gateway this computer is authorized for.
`,
	"daemon": `Usage:
  linger-computer daemon <command>

Commands:
  start                        Start the background daemon
  stop [--if-idle]             Stop the background daemon
  restart                      Restart the background daemon
  status [--json]              Show the process, connection, and runtime status
  logs [-f] [-n <lines>]       Show daemon logs
  runners [--json]             List Agent runners
  runners inspect <agent-id>   Show one Agent runner
  runners stop <agent-id>      Stop one Agent runner
  service list [--json]        List managed services
  service start <name> -- <command> [args...]
                               Start a managed service
  service stop <name>          Stop a managed service
`,
	"daemon start": `Usage:
  linger-computer daemon start [--config <path>]

Start the background daemon and wait for the server to confirm the connection.
`,
	"daemon stop": `Usage:
  linger-computer daemon stop [--if-idle] [--config <path>]

Options:
  --if-idle                    Stop only when no Operation is running
`,
	"daemon restart": `Usage:
  linger-computer daemon restart [--config <path>]
`,
	"daemon status": `Usage:
  linger-computer daemon status [--json] [--config <path>]

Show the daemon process, the server connection, and the runtime summary.
`,
	"daemon logs": `Usage:
  linger-computer daemon logs [-f] [-n <lines>] [--config <path>]

Options:
  -f, --follow                 Keep printing new log lines
  -n <lines>                   Number of lines to show (default: 200)
`,
	"daemon runners": `Usage:
  linger-computer daemon runners [--json]
  linger-computer daemon runners inspect <agent-id>
  linger-computer daemon runners stop <agent-id>
`,
	"daemon service": `Usage:
  linger-computer daemon service list [--json]
  linger-computer daemon service start <name> -- <command> [args...]
  linger-computer daemon service stop <name>
`,
	"runtime": `Usage:
  linger-computer runtime check [codex|claude|pi] [options]

Commands:
  check                        Check Codex, Claude Code, and Pi on this computer
`,
	"runtime check": `Usage:
  linger-computer runtime check [codex|claude|pi] [options]

Check whether each runtime is installed, signed in, and compatible.
Works without login and without a running daemon.

Statuses:
  READY                        Install, version, sign-in, and protocol checks passed
  NOT_INSTALLED                No usable executable was found
  AUTH_REQUIRED                The runtime needs sign-in or credentials
  INCOMPATIBLE                 The version or protocol is not supported
  ERROR                        The check failed; the reason is shown

Exit code: 0 when at least one checked runtime is READY. A single-runtime
check returns 13 for NOT_INSTALLED, 11 for AUTH_REQUIRED, 14 for
INCOMPATIBLE, and 1 for ERROR.

Options:
  --live                       Also ask each READY runtime for a model reply
  --json                       Print machine-readable results
` + runtimePathOptions + "\n" + configOption + "\n",
	"doctor": `Usage:
  linger-computer doctor [--json] [--prune] [options]

Check the installation, configuration, connection, and runtimes.

Options:
  --json                       Print machine-readable results
  --prune                      Remove this computer's local enrollment
` + runtimePathOptions + "\n" + configOption + "\n",
	"version": `Usage:
  linger-computer version
`,
}

const generalHelp = `Linger Computer connects this computer to Linger so agents can run here.

Usage:
  linger-computer <command> [options]

Commands:
  login                        Authorize and connect this computer
  auth status                  Show the site, Computer, and authorization
  daemon start|stop|restart    Manage the background daemon
  daemon status                Show the connection and runtime summary
  daemon logs [-f]             Show daemon logs
  runtime check [name]         Check Codex, Claude Code, and Pi
  doctor                       Check installation, connection, and runtimes
  version                      Show the CLI version

Get started:
  linger-computer login

Run "linger-computer <command> --help" for options.
`

// usage renders help naming this environment's own command.
func usage(topic, commandName string) string {
	text := generalHelp
	if topic != "" {
		text = commandHelp[topic]
	}
	return strings.ReplaceAll(text, "linger-computer ", commandName+" ")
}
