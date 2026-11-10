// linger-computer-launcher is the stable Windows command for a fixed,
// installed program. It runs it without a command shell: PowerShell must never
// route CLI text through cmd.
//
// Installed as linger-computer-<environment>.exe it runs that environment's
// active-bundle Computer CLI, named by the <environment>.launcher.json beside
// it. Installed as linger-computer.exe it runs the environment when it is the
// only one in its directory and lists them otherwise. Installed as teamhub.exe
// in a bundle it runs that bundle's Node TeamHub CLI.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const launcherIdentity = "linger-native-cli-launcher-v1"

var (
	bundleName      = regexp.MustCompile(`^lib-[0-9a-f]{16}-[0-9a-f-]+$`)
	environmentName = regexp.MustCompile(`^linger-computer-[a-z0-9][a-z0-9-]*$`)
)

// dispatchError is the dispatcher's message to the user when it cannot pick
// one environment, with the exit code to end with.
type dispatchError struct {
	message string
	code    int
}

func (e dispatchError) Error() string { return e.message }

type launcherConfig struct {
	SchemaVersion int    `json:"schemaVersion"`
	DataRoot      string `json:"dataRoot"`
}

type launchTarget struct {
	program           string
	arguments         []string
	dataRoot          string
	launcher, command string
}

// environmentLaunchers returns the environment launchers installed beside the
// dispatcher, by command name.
func environmentLaunchers(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	var launchers []string
	for _, entry := range entries {
		command := strings.TrimSuffix(strings.ToLower(entry.Name()), ".exe")
		if !environmentName.MatchString(command) || !strings.EqualFold(filepath.Ext(entry.Name()), ".exe") {
			continue
		}
		if _, err := os.Stat(filepath.Join(directory, command+".launcher.json")); err == nil {
			launchers = append(launchers, filepath.Join(directory, entry.Name()))
		}
	}
	return launchers, nil
}

func readLauncherConfig(file string) (string, error) {
	content, err := privatefs.ReadFile(file, 32*1024)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var config launcherConfig
	if err := decoder.Decode(&config); err != nil {
		return "", errors.New("invalid launcher configuration")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || config.SchemaVersion != 1 || !filepath.IsAbs(config.DataRoot) || strings.HasPrefix(config.DataRoot, `\\`) {
		return "", errors.New("invalid launcher configuration")
	}
	root := filepath.Clean(config.DataRoot)
	if filepath.Dir(root) == root {
		return "", errors.New("invalid installation root")
	}
	return root, nil
}

// dispatch picks the only environment launcher beside the dispatcher.
func dispatch(directory string) (string, error) {
	launchers, err := environmentLaunchers(directory)
	if err != nil {
		return "", err
	}
	switch len(launchers) {
	case 0:
		return "", dispatchError{message: "Linger Computer is not installed for any environment. Install it from the Computers page of your Linger Web app.", code: 1}
	case 1:
		return launchers[0], nil
	}
	listing := fmt.Sprintf("Linger Computer is installed for %d environments on this computer. Run the command of the environment you mean:", len(launchers))
	for _, launcher := range launchers {
		command := strings.TrimSuffix(filepath.Base(launcher), filepath.Ext(launcher))
		origin := ""
		if root, err := readLauncherConfig(filepath.Join(directory, command+".launcher.json")); err == nil {
			if value, err := privatefs.ReadFile(filepath.Join(root, "web-origin"), 32*1024); err == nil {
				origin = strings.TrimSpace(string(value))
			}
		}
		listing += fmt.Sprintf("\n  %-34s %s", command, origin)
	}
	return "", dispatchError{message: listing, code: 2}
}

func resolveTarget(executable string) (launchTarget, error) {
	if err := privatefs.CheckPath(executable, "file", true); err != nil {
		return launchTarget{}, err
	}
	name := strings.ToLower(filepath.Base(executable))
	if name == "linger-computer.exe" {
		launcher, err := dispatch(filepath.Dir(executable))
		if err != nil {
			return launchTarget{}, err
		}
		return resolveTarget(launcher)
	}
	var target launchTarget
	var bundle string
	var files []string
	switch {
	case name == "teamhub.exe":
		bundle = filepath.Dir(filepath.Dir(executable))
		entry := filepath.Join(bundle, "cli", "teamhub.js")
		target = launchTarget{program: filepath.Join(bundle, "runtime", "bin", "node.exe"), arguments: []string{"--use-env-proxy", entry}}
		files = []string{target.program, entry}
	case strings.HasSuffix(name, ".exe") && environmentName.MatchString(strings.TrimSuffix(name, ".exe")):
		command := strings.TrimSuffix(name, ".exe")
		root, err := readLauncherConfig(filepath.Join(filepath.Dir(executable), command+".launcher.json"))
		if err != nil {
			return launchTarget{}, err
		}
		if err := privatefs.CheckPath(root, "directory", true); err != nil {
			return launchTarget{}, err
		}
		pointer, err := privatefs.ReadFile(filepath.Join(root, "active-bundle"), 1024)
		if err != nil {
			return launchTarget{}, err
		}
		active := strings.TrimSpace(string(pointer))
		if !bundleName.MatchString(active) {
			return launchTarget{}, errors.New("invalid installed bundle pointer")
		}
		bundle = filepath.Join(root, active)
		target = launchTarget{program: filepath.Join(bundle, "cli", "linger-computer.exe"), dataRoot: root, launcher: executable, command: command}
		files = []string{target.program}
	default:
		return launchTarget{}, errors.New("unsupported CLI launcher name")
	}
	if err := privatefs.CheckPath(bundle, "directory", true); err != nil {
		return launchTarget{}, err
	}
	for _, file := range files {
		if err := privatefs.CheckPath(file, "file", true); err != nil {
			return launchTarget{}, err
		}
	}
	return target, nil
}

func run(executable string, args []string) error {
	target, err := resolveTarget(executable)
	if err != nil {
		return err
	}
	if target.dataRoot != "" {
		if err := validateDataRootOverride(target.dataRoot); err != nil {
			return err
		}
		// Bind the stable launcher to its installer-owned record. A caller cannot
		// redirect it to a different executable with an environment override.
		_ = os.Setenv("LINGER_COMPUTER_DATA_DIR", target.dataRoot)
		_ = os.Setenv("LINGER_COMPUTER_LAUNCHER", target.launcher)
		_ = os.Setenv("LINGER_COMPUTER_COMMAND", target.command)
		if os.Getenv("LINGER_COMPUTER_CONFIG") == "" {
			_ = os.Setenv("LINGER_COMPUTER_CONFIG", filepath.Join(target.dataRoot, "config.json"))
		}
		if os.Getenv("LINGER_WEB_URL") == "" {
			value, err := privatefs.ReadFile(filepath.Join(target.dataRoot, "web-origin"), 32*1024)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if err == nil {
				_ = os.Setenv("LINGER_WEB_URL", strings.TrimSpace(string(value)))
			}
		}
	}
	command := exec.Command(target.program, append(slices.Clone(target.arguments), args...)...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	return command.Run()
}

func validateDataRootOverride(root string) error {
	value := os.Getenv("LINGER_COMPUTER_DATA_DIR")
	if value == "" {
		return nil
	}
	provided, err := filepath.Abs(value)
	if err == nil && (provided == root || runtime.GOOS == "windows" && strings.EqualFold(provided, root)) {
		return nil
	}
	return fmt.Errorf("LINGER_COMPUTER_DATA_DIR differs from this launcher installation at %s; use that environment's own linger-computer-<environment>.exe", root)
}

func main() {
	executable, err := os.Executable()
	if err == nil {
		err = run(executable, os.Args[1:])
	}
	if err == nil {
		return
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() >= 0 {
		os.Exit(exit.ExitCode())
	}
	var dispatched dispatchError
	if errors.As(err, &dispatched) {
		fmt.Fprintln(os.Stderr, dispatched.message)
		os.Exit(dispatched.code)
	}
	fmt.Fprintln(os.Stderr, launcherIdentity+": "+err.Error())
	os.Exit(1)
}
