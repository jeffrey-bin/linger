package localtools

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// reclaimProfile stops a Chrome that an earlier Daemon left on this Agent
// profile, as after the Daemon was killed. Chrome then hands every new launch
// to that process and exits, so no browser call could succeed until the user
// found and ended it. Only a process whose command line names this exact
// profile is stopped, and it is stopped as the process group it was started as.
func reclaimProfile(profile string) error {
	target, err := os.Readlink(filepath.Join(profile, "SingletonLock"))
	if err != nil {
		return nil //nolint:nilerr // no lock: no earlier Chrome holds the profile
	}
	// The lock names "<hostname>-<pid>"; a host name may contain dashes.
	pid, err := strconv.Atoi(target[strings.LastIndex(target, "-")+1:])
	if err != nil || pid <= 1 {
		return nil //nolint:nilerr // a lock Chrome itself will replace
	}
	if !ownsProfile(pid, profile) {
		return nil
	}
	for _, signal := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		if syscall.Kill(-pid, signal) != nil {
			_ = syscall.Kill(pid, signal)
		}
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
			if !ownsProfile(pid, profile) {
				return nil
			}
		}
	}
	return fmt.Errorf("an earlier Chrome (process %d) still holds this Agent's browser profile", pid)
}

// ownsProfile reports whether pid runs with exactly this profile. Chrome
// rewrites its command line with spaces between the arguments, so either a
// NUL or a space may end the flag.
func ownsProfile(pid int, profile string) bool {
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	flag := []byte("--user-data-dir=" + profile)
	for rest := cmdline; ; {
		index := bytes.Index(rest, flag)
		if index < 0 {
			return false
		}
		rest = rest[index+len(flag):]
		if len(rest) == 0 || rest[0] == 0 || rest[0] == ' ' {
			return true
		}
	}
}

// errNoDisplay reports a Daemon outside a graphical session, where Chrome
// exits at once because it cannot open a window.
var errNoDisplay = errors.New("BROWSER_UNAVAILABLE: the Computer has no desktop session (DISPLAY and WAYLAND_DISPLAY are unset), so it cannot open a browser window; start the Computer from the signed-in user's desktop session")

func checkBrowserDisplay(env []string) error {
	if environmentValue(env, "DISPLAY") == "" && environmentValue(env, "WAYLAND_DISPLAY") == "" {
		return errNoDisplay
	}
	return nil
}
