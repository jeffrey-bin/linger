package native

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// MinimumVersions is the product compatibility policy per Runtime kind. The
// Claude minimum is the first release with the permission-review control
// protocol.
var MinimumVersions = map[string]string{
	"codex":  "0.100.0",
	"claude": "2.1.282",
	"pi":     "1.2.0",
}

const (
	codexDirectToolsVersion    = "0.163.0"
	codexPermissionHookVersion = "0.163.0"
)

var (
	errNoVersion       = errors.New("Runtime did not report a recognizable version")
	errVersionOverflow = errors.New("Runtime version component exceeds numeric range")
)

// VersionTooOldError is shown to users as RUNTIME_INCOMPATIBLE.
type VersionTooOldError struct {
	Runtime  string
	Found    string
	Required string
}

func (e *VersionTooOldError) Error() string {
	return fmt.Sprintf("%s version %s is below minimum %s", e.Runtime, e.Found, e.Required)
}

type versionNumber [3]uint64

func (v versionNumber) less(other versionNumber) bool {
	for i := range v {
		if v[i] != other[i] {
			return v[i] < other[i]
		}
	}
	return false
}

// versionToken finds the first X.Y.Z in text. A "v" right before it belongs
// to the token; anything after the third part does not.
func versionToken(text string) (string, versionNumber, error) {
	i := 0
	for i < len(text) {
		if !isDigit(text[i]) {
			i++
			continue
		}
		start := i
		var number versionNumber
		matched := true
		for part := 0; part < 3; part++ {
			if part > 0 {
				if i >= len(text) || text[i] != '.' || i+1 >= len(text) || !isDigit(text[i+1]) {
					matched = false
					break
				}
				i++
			}
			digitsStart := i
			for i < len(text) && isDigit(text[i]) {
				i++
			}
			value, err := strconv.ParseUint(text[digitsStart:i], 10, 64)
			if err != nil {
				return "", versionNumber{}, errVersionOverflow
			}
			number[part] = value
		}
		if !matched {
			continue
		}
		if start > 0 && text[start-1] == 'v' {
			start--
		}
		return text[start:i], number, nil
	}
	return "", versionNumber{}, errNoVersion
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// versionAtLeast reports whether observed carries a version at or above
// minimum. An unrecognizable observed version is never at least anything.
func versionAtLeast(observed, minimum string) bool {
	_, have, err := versionToken(observed)
	if err != nil {
		return false
	}
	_, want, err := versionToken(minimum)
	return err == nil && !have.less(want)
}

// RequireVersion enforces MinimumVersions. A parse failure is returned as
// is and is never reported as too old.
func RequireVersion(kind, observed string) error {
	minimum, ok := MinimumVersions[kind]
	if !ok {
		return nil
	}
	_, have, err := versionToken(observed)
	if err != nil {
		return err
	}
	_, want, err := versionToken(minimum)
	if err != nil {
		return err
	}
	if have.less(want) {
		return &VersionTooOldError{Runtime: kind, Found: observed, Required: minimum}
	}
	return nil
}

// stableCodexVersion accepts only a bare stable X.Y.Z (optionally
// v-prefixed), after an optional "codex-cli " prefix.
func stableCodexVersion(version string) (versionNumber, bool) {
	version = strings.TrimPrefix(strings.TrimSpace(version), "codex-cli ")
	token, number, err := versionToken(version)
	if err != nil || token != version {
		return versionNumber{}, false
	}
	return number, true
}

func stableCodexAtLeast(version, minimum string) bool {
	have, ok := stableCodexVersion(version)
	if !ok {
		return false
	}
	_, want, _ := versionToken(minimum)
	return !have.less(want)
}

func CodexSupportsDirectTools(version string) bool {
	return stableCodexAtLeast(version, codexDirectToolsVersion)
}

func CodexSupportsPermissionHook(version string) bool {
	return stableCodexAtLeast(version, codexPermissionHookVersion)
}

const versionProbePipeBudget = 2 * time.Second

// versionProbeBudget bounds one ProbeVersion call; tests lower it.
var versionProbeBudget = 10 * time.Second

// ProbeVersion runs the CLI with --version and returns the first stdout line
// that carries a recognizable version, trimmed. Every process it started is
// gone when it returns.
func ProbeVersion(ctx context.Context, inv Invocation) (string, error) {
	probeCtx, cancel := context.WithTimeout(ctx, versionProbeBudget)
	defer cancel()
	cmd := ownedCommand(probeCtx, inv, "--version")
	cmd.WaitDelay = versionProbePipeBudget
	stdout, err := runOutput(probeCtx, cmd)
	version, recognized := versionLine(string(stdout))
	if err != nil {
		// A descendant that keeps the pipe open after a complete answer only
		// delays the run; the answer itself stands.
		if errors.Is(err, exec.ErrWaitDelay) && recognized && probeCtx.Err() == nil {
			return version, nil
		}
		return "", fmt.Errorf("Runtime version probe failed: %w", ExplainExecError(err))
	}
	if version == "" {
		return "", errors.New("Runtime version probe returned no output")
	}
	return version, nil
}

// versionLine picks the first line with a recognizable version, or the
// whole trimmed output when none has one.
func versionLine(output string) (string, bool) {
	for line := range strings.SplitSeq(output, "\n") {
		if _, _, err := versionToken(line); err == nil {
			return strings.TrimSpace(line), true
		}
	}
	return strings.TrimSpace(output), false
}
