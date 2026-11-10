package computercli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/control"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// Windows discovery can use 30 seconds for readiness and another 30 for the
// model catalog; the bound includes initialization and control calls.
func daemonStartTimeout() time.Duration {
	if runtime.GOOS == "windows" {
		return 90 * time.Second
	}
	return 30 * time.Second
}

const controlPollInterval = 50 * time.Millisecond

// daemonExecutable is the Go Daemon of this installation. Source development
// names its build with LINGER_GO_LOCAL_DAEMON_PATH.
func daemonExecutable(environment map[string]string) (string, error) {
	if explicit := strings.TrimSpace(environment["LINGER_GO_LOCAL_DAEMON_PATH"]); explicit != "" {
		if !filepath.IsAbs(explicit) {
			return "", errors.New("LINGER_GO_LOCAL_DAEMON_PATH must be absolute")
		}
		return explicit, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	name := "linger-computer-daemon"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	daemon := filepath.Join(filepath.Dir(filepath.Dir(executable)), "daemon", name)
	if _, err := os.Stat(daemon); err != nil {
		return "", errors.New("LINGER_GO_LOCAL_DAEMON_PATH is required for source development")
	}
	return daemon, nil
}

func loadFullConfig(configPath string, environment map[string]string) (computerconfig.Config, error) {
	config, err := computerconfig.Load(configPath, environment)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return config, &configError{message: err.Error()}
	}
	return config, err
}

// startDetachedDaemon starts the Daemon in its own session and waits until its
// control endpoint answers with this launch's nonce.
func startDetachedDaemon(ctx context.Context, configPath string, environment map[string]string, commandName string) (resultErr error) {
	config, err := loadFullConfig(configPath, environment)
	if err != nil {
		return err
	}
	if err := privatefs.EnsureDir(config.StateDirectory); err != nil {
		return err
	}
	rotateDaemonLog(config.StateDirectory)
	log, err := privatefs.OpenLog(filepath.Join(config.StateDirectory, "daemon.log"))
	if err != nil {
		return err
	}
	defer log.Close()
	daemon, err := daemonExecutable(environment)
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	absoluteConfig, err := filepath.Abs(configPath)
	if err != nil {
		return err
	}
	serviceCommand, err := installedWindowsServiceCommand(executable, absoluteConfig, environment["LINGER_COMPUTER_DATA_DIR"], environment["LINGER_COMPUTER_LAUNCHER"])
	if err != nil {
		return err
	}
	if serviceCommand == nil {
		serviceCommand = []string{executable, "--config", absoluteConfig}
	}
	encodedServiceCommand, err := json.Marshal(serviceCommand)
	if err != nil {
		return err
	}
	launchNonce := uuid.NewString()
	child, err := startDetached(func() *exec.Cmd {
		command := exec.Command(daemon, "--config", configPath)
		command.Env = append(os.Environ(), "LINGER_DAEMON_LAUNCH_NONCE="+launchNonce, "LINGER_COMPUTER_SERVICE_COMMAND="+string(encodedServiceCommand))
		command.Stdout, command.Stderr = log, log
		return command
	})
	if err != nil {
		return err
	}
	identity := inspectChild(child.Process.Pid)
	// done closes before exited receives the code, so once the readiness wait
	// has seen the exit, termination never acts on the reaped child.
	exited := make(chan string, 1)
	done := make(chan struct{})
	go func() {
		err := child.Wait()
		close(done)
		var exit *exec.ExitError
		switch {
		case errors.As(err, &exit) && exit.ExitCode() >= 0:
			exited <- fmt.Sprint(exit.ExitCode())
		case errors.As(err, &exit):
			exited <- exit.String()
		case err != nil:
			exited <- "unknown"
		default:
			exited <- "0"
		}
	}()
	defer func() {
		if resultErr != nil {
			resultErr = errors.Join(resultErr, terminateSpawnedDaemon(child, identity, done))
		}
	}()
	return waitUntilReachableOrExit(ctx, newDaemonClient(config.StateDirectory), launchNonce, exited, daemonStartTimeout(), commandName)
}

// rotateDaemonLog keeps the previous run's log as daemon.log.1. A running
// Daemon still writes to the file it started with, so the log stays while its
// lease marker exists. A log another process holds open is appended to.
func rotateDaemonLog(stateDirectory string) {
	if _, err := os.Lstat(filepath.Join(stateDirectory, "daemon.lock")); !errors.Is(err, os.ErrNotExist) {
		return
	}
	logPath := filepath.Join(stateDirectory, "daemon.log")
	_ = os.Rename(logPath, logPath+".1")
}

var installedBundle = regexp.MustCompile(`^lib-[0-9a-f]{16}-[0-9a-f-]+$`)

// installedWindowsServiceCommand binds the stable environment launcher, whose
// path survives bundle upgrades, when this CLI runs from that installation's
// active bundle. Other launches keep their exact argv.
func installedWindowsServiceCommand(executable, configPath, dataRoot, launcher string) ([]string, error) {
	if runtime.GOOS != "windows" || dataRoot == "" || launcher == "" {
		return nil, nil
	}
	command, err := boundLauncher(executable, configPath, dataRoot, launcher)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return command, err
}

func boundLauncher(executable, configPath, dataRoot, launcher string) ([]string, error) {
	pointer, err := os.ReadFile(filepath.Join(dataRoot, "active-bundle"))
	if err != nil {
		return nil, err
	}
	bundle := strings.TrimSpace(string(pointer))
	if !installedBundle.MatchString(bundle) {
		return nil, nil
	}
	bundleRoot, err := filepath.EvalSymlinks(filepath.Join(dataRoot, bundle))
	if err != nil {
		return nil, err
	}
	if relative, err := filepath.Rel(bundleRoot, executable); err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, nil //nolint:nilerr // a CLI outside the active bundle is not the installed one
	}
	launcher, err = filepath.Abs(launcher)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(launcher)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil
	}
	content, err := os.ReadFile(launcher)
	if err != nil {
		return nil, err
	}
	if !bytes.Contains(content, []byte("linger-native-cli-launcher-v1")) {
		return nil, nil
	}
	encoded, err := os.ReadFile(filepath.Join(filepath.Dir(launcher), strings.TrimSuffix(filepath.Base(launcher), filepath.Ext(launcher))+".launcher.json"))
	if err != nil {
		return nil, err
	}
	var binding struct {
		SchemaVersion int    `json:"schemaVersion"`
		DataRoot      string `json:"dataRoot"`
	}
	decoded := json.Unmarshal(encoded, &binding) == nil
	if !decoded || binding.SchemaVersion != 1 || !sameAbsolutePath(binding.DataRoot, dataRoot) {
		return nil, nil
	}
	return []string{launcher, "--config", configPath}, nil
}

func sameAbsolutePath(left, right string) bool {
	leftPath, leftErr := filepath.Abs(left)
	rightPath, rightErr := filepath.Abs(right)
	return leftErr == nil && rightErr == nil && leftPath == rightPath
}

var errExistingDaemon = errors.New("Computer daemon is already running")

func waitUntilReachableOrExit(ctx context.Context, client controlClient, launchNonce string, exited <-chan string, timeout time.Duration, commandName string) error {
	deadline := time.Now().Add(timeout)
	for {
		select {
		case code := <-exited:
			return newError(categoryDaemonLifecycle, "Computer daemon exited before becoming ready ("+code+")")
		default:
		}
		status, err := client.Status(ctx)
		if err == nil {
			if nonce, _ := status.string("launch_nonce"); nonce != launchNonce {
				return errExistingDaemon
			}
			return nil
		}
		if !time.Now().Before(deadline) {
			return wrapError(categoryDaemonLifecycle, "Computer daemon did not become ready; inspect "+commandName+" daemon logs", err)
		}
		if err := sleep(ctx, pollInterval()); err != nil {
			return err
		}
	}
}

// pollInterval is slower on Windows, where each control call costs a pipe
// handshake that antivirus inspects.
func pollInterval() time.Duration {
	if runtime.GOOS == "windows" {
		return 500 * time.Millisecond
	}
	return controlPollInterval
}

func sleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// waitUntilDaemonStops waits until the control endpoint closes and the Daemon
// process has exited.
func waitUntilDaemonStops(ctx context.Context, client controlClient, pid int) error {
	deadline := time.Now().Add(10 * time.Second)
	controlStopped := false
	for {
		if !controlStopped {
			if _, err := client.Status(ctx); err != nil {
				controlStopped = true
			}
		}
		if controlStopped && !processExists(pid) {
			return nil
		}
		if !time.Now().Before(deadline) {
			return newError(categoryDaemonLifecycle, "Computer daemon did not stop")
		}
		if err := sleep(ctx, pollInterval()); err != nil {
			return err
		}
	}
}

// stopUnreachableDaemon stops the recorded Daemon generation when its control
// endpoint no longer answers.
func stopUnreachableDaemon(ctx context.Context, configPath string, environment map[string]string) (bool, error) {
	config, err := loadFullConfig(configPath, environment)
	if err != nil {
		return false, err
	}
	return control.StopOwner(ctx, config.StateDirectory)
}

// confirmDaemonStopped proves from the private state alone that no Daemon owns
// this Computer.
func confirmDaemonStopped(ctx context.Context, configPath string) (bool, error) {
	stateDirectory, err := loadStateDirectory(configPath)
	if err != nil {
		return false, err
	}
	if runtime.GOOS != "windows" {
		if err := privatefs.CheckPath(stateDirectory, "directory", false); err != nil {
			return false, errors.New("Computer state directory is unsafe")
		}
	}
	return control.OwnerStopped(ctx, stateDirectory)
}
