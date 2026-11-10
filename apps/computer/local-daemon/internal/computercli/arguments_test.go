package computercli

import (
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestTopLevelHelpListsOnlyTheMainCommands(t *testing.T) {
	f := newFixture(t)
	if code := f.run("--help"); code != 0 {
		t.Fatalf("exit=%d", code)
	}
	if got := f.stdout.String(); got != generalHelp {
		t.Fatalf("help=%q", got)
	}
	for _, command := range []string{"login", "auth status", "daemon start|stop|restart", "daemon status", "daemon logs [-f]", "runtime check [name]", "doctor", "version"} {
		contains(t, generalHelp, command)
	}
	if regexp.MustCompile(`--token|--gateway-url|provision|runners|service`).MatchString(generalHelp) {
		t.Fatal("top-level help lists subcommand options")
	}
	for _, args := range [][]string{{}, {"help"}, {"-h"}} {
		f.clear()
		if code := f.run(args...); code != 0 || f.stdout.String() != generalHelp {
			t.Fatalf("%v exit=%d", args, code)
		}
	}
}

func TestSubcommandHelpTopics(t *testing.T) {
	f := newFixture(t)
	for args, topic := range map[string]string{
		"daemon --help":         "daemon",
		"daemon":                "daemon",
		"help daemon":           "daemon",
		"help daemon start":     "daemon start",
		"daemon start --help":   "daemon start",
		"daemon runners -h":     "daemon runners",
		"login --help":          "login",
		"auth":                  "auth",
		"help auth status":      "auth status",
		"runtime check --help":  "runtime check",
		"doctor -h":             "doctor",
		"version --help":        "version",
		"daemon service --help": "daemon service",
	} {
		f.clear()
		if code := f.run(strings.Fields(args)...); code != 0 {
			t.Fatalf("%q exit=%d", args, code)
		}
		if got := f.stdout.String(); got != commandHelp[topic] {
			t.Fatalf("%q help=%q", args, got)
		}
	}
	contains(t, commandHelp["daemon"], "runners inspect <agent-id>")
	contains(t, commandHelp["daemon"], "service start <name>")
}

func TestLoginHelpKeepsOnlyTheRemainingPairingPaths(t *testing.T) {
	want := `Usage:
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
  --codex-path <path>          Use this Codex executable
  --claude-path <path>         Use this Claude Code executable
  --pi-path <path>             Use this Pi executable
  --config <path>              Use another Computer config file
`
	if commandHelp["login"] != want {
		t.Fatalf("login help=%q", commandHelp["login"])
	}
	if strings.Contains(commandHelp["auth"], "provision") || commandHelp["auth provision"] != "" {
		t.Fatal("auth help lists the removed provision command")
	}
}

func TestRemovedAndUnknownCommandsAreUsageErrors(t *testing.T) {
	f := newFixture(t)
	for _, args := range [][]string{{"setup"}, {"start"}, {"status"}, {"provision"}, {"daemon", "bogus"}, {"help", "bogus"}, {"daemon", "start", "extra"}, {"auth", "status", "extra"}, {"daemon", "help", "extra"}} {
		f.clear()
		if code := f.run(args...); code != 2 {
			t.Fatalf("%v exit=%d", args, code)
		}
		want := "Unknown command: " + strings.Join(args, " ") + "\nRun \"linger-computer --help\" for usage.\n"
		if got := f.stderr.String(); got != want {
			t.Fatalf("%v stderr=%q", args, got)
		}
	}
	f.clear()
	if code := f.run("daemon", "status", "--json", "--json"); code != 2 {
		t.Fatalf("duplicate flag exit=%d", code)
	}
	contains(t, f.stderr.String(), "--json may only be provided once")
	f.clear()
	if code := f.run("doctor", "--config"); code != 2 {
		t.Fatalf("missing value exit=%d", code)
	}
	contains(t, f.stderr.String(), "--config requires a value")
}

func TestParsedCommandShapes(t *testing.T) {
	options := parseOptions{goos: "darwin", environment: map[string]string{}, homeDirectory: "/home/user", hostName: "Host", workingDirectory: "/work", commandName: "linger-computer"}
	parsed, err := parseArguments([]string{"login", "--enabled-runtime", "pi", "--enabled-runtime", "codex", "--codex-auth", "auth.json", "--name", "Desk"}, options)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(parsed.enabledRuntimes, []string{"pi", "codex"}) || parsed.codexAuthFile != filepath.Join(string(filepath.Separator), "work", "auth.json") || parsed.displayName != "Desk" || parsed.webURL != "http://localhost:3000" {
		t.Fatalf("login=%+v", parsed)
	}
	parsed, _ = parseArguments([]string{"login"}, parseOptions{environment: map[string]string{"LINGER_WEB_URL": "https://app.example.test"}, hostName: "Host", workingDirectory: "/work", homeDirectory: "/home/user"})
	if parsed.webURL != "https://app.example.test" || parsed.displayName != "Host" || parsed.enabledRuntimes != nil {
		t.Fatalf("login defaults=%+v", parsed)
	}
	for _, args := range [][]string{{"login", "--enabled-runtime", "codex", "--enabled-runtime", "codex"}, {"login", "--enabled-runtime", "gemini"}, {"login", "--enabled-runtime"}} {
		if _, err := parseArguments(args, options); err == nil {
			t.Fatalf("%v accepted", args)
		}
	}
	parsed, _ = parseArguments([]string{"runtime", "check", "claude-code", "--live", "--pi-path", "bin/pi"}, options)
	if parsed.name != "runtime-check" || parsed.runtime != "claude" || !parsed.live || parsed.runtimePaths["pi"] != filepath.Join(string(filepath.Separator), "work", "bin", "pi") {
		t.Fatalf("runtime check=%+v", parsed)
	}
	parsed, _ = parseArguments([]string{"daemon", "logs", "--follow"}, options)
	if !parsed.follow || parsed.lines != 200 {
		t.Fatalf("logs=%+v", parsed)
	}
	if _, err := parseArguments([]string{"daemon", "runners", "inspect", " "}, options); err == nil || err.Error() != "Agent id must not be empty" {
		t.Fatalf("empty agent id err=%v", err)
	}
}
