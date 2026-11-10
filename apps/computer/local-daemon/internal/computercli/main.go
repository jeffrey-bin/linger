package computercli

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"golang.org/x/term"
)

// Main runs the CLI for this process and returns its exit code.
func Main(args []string) int {
	// Runtime discovery logs for the Daemon; the CLI reports its own results.
	slog.SetDefault(slog.New(slog.DiscardHandler))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return Run(ctx, args, defaultDeps())
}

func defaultDeps() deps {
	environment := computerconfig.ProcessEnvironment()
	home, _ := os.UserHomeDir()
	host, _ := os.Hostname()
	workingDirectory, _ := os.Getwd()
	commandName := commandName(environment)
	result := deps{
		connectionWait: 15 * time.Second, environment: environment, homeDirectory: home, hostName: host,
		goos: runtime.GOOS, workingDirectory: workingDirectory,
		stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr,
		rawTerminal:      rawStdin,
		checkUserSession: checkUserSession,
		checkRuntime:     checkRuntime,
		diagnoseRuntimes: diagnoseRuntimes,
		newClient:        newDaemonClient,
		probeGateway:     probeGatewayNetwork,
		productRuntime:   bundledNodeCheck,
		readLogs:         streamComputerLogs,
		startDaemon: func(ctx context.Context, configPath string) error {
			return startDetachedDaemon(ctx, configPath, environment, commandName)
		},
		confirmDaemonStopped: confirmDaemonStopped,
		stopUnreachableDaemon: func(ctx context.Context, configPath string) (bool, error) {
			return stopUnreachableDaemon(ctx, configPath, environment)
		},
		waitForDaemonStop: waitUntilDaemonStops,
	}
	result.inspectDaemon = func(ctx context.Context, stateDirectory string) doctorCheck {
		return inspectDaemonHealth(ctx, newDaemonClient(stateDirectory), commandName)
	}
	result.setup = func(ctx context.Context, options setupOptions) (setupResult, error) {
		return runComputerSetup(ctx, options, setupDeps{
			environment: environment, homeDirectory: home, httpClient: newExchangeClient(),
			openBrowser: openBrowser(os.Stdout, runtime.GOOS, environment),
			startDaemon: result.startDaemon,
			stopExistingDaemon: func(ctx context.Context, configPath string, ifIdle bool) (bool, error) {
				return stopConfiguredDaemon(ctx, configPath, ifIdle, environment, newDaemonClient)
			},
		})
	}
	return result
}

// rawStdin puts a terminal stdin into raw mode so a pasted token is not echoed.
func rawStdin() (func(), bool, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return nil, false, nil
	}
	state, err := term.MakeRaw(fd)
	if err != nil {
		return nil, false, err
	}
	return func() { _ = term.Restore(fd, state) }, true, nil
}
