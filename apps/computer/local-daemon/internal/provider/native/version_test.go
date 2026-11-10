package native

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRequireVersion(t *testing.T) {
	cases := []struct {
		kind, version string
		accepted      bool
		tooOld        bool
	}{
		{"codex", "wrapper\n codex-cli 0.100.0", true, false},
		{"claude", "v1.99.999 (fixture)", false, true},
		{"pi", "fixture 1.2.0+build", true, false},
		{"codex", "0.100.999999999999999999999999", false, false},
		{"codex", "loading plugins", false, false},
		{"codex", "", false, false},
		{"claude", "2.1.281", false, true},
		{"claude", "2.0.0", false, true},
		{"claude", "2.1.282", true, false},
		{"claude", "2.1.300 (Claude Code)", true, false},
		{"hermes", "anything", true, false},
	}
	for _, tc := range cases {
		err := RequireVersion(tc.kind, tc.version)
		var tooOld *VersionTooOldError
		isTooOld := errors.As(err, &tooOld)
		if (err == nil) != tc.accepted || isTooOld != tc.tooOld {
			t.Fatalf("RequireVersion(%q, %q) = %v", tc.kind, tc.version, err)
		}
		if isTooOld && (tooOld.Runtime != tc.kind || tooOld.Found != tc.version || tooOld.Required != MinimumVersions[tc.kind]) {
			t.Fatalf("too-old fields = %+v", tooOld)
		}
	}
	err := RequireVersion("claude", "2.1.281")
	if err.Error() != "claude version 2.1.281 is below minimum 2.1.282" {
		t.Fatalf("message = %q", err)
	}
}

func TestVersionTokens(t *testing.T) {
	if token, _, err := versionToken("0.155.1-beta"); err != nil || token == "0.155.1-beta" || token != "0.155.1" {
		t.Fatalf("token = %q, %v", token, err)
	}
	if token, _, _ := versionToken("tool v2.3.4 build"); token != "v2.3.4" {
		t.Fatalf("v token = %q", token)
	}
	if token, _, _ := versionToken("1.2.x then 3.4.5"); token != "3.4.5" {
		t.Fatalf("token after failed candidate = %q", token)
	}
	if token, _, _ := versionToken("11.2.3"); token != "11.2.3" {
		t.Fatalf("token = %q", token)
	}
	if !versionAtLeast("codex-cli 1.0.0", "0.999.999") {
		t.Fatal("1.0.0 must be at least 0.999.999")
	}
	if versionAtLeast("missing", "0.100.0") {
		t.Fatal("missing version must not satisfy a minimum")
	}
	if _, _, err := versionToken("9.99999999999999999999.1"); err == nil || err.Error() != "Runtime version component exceeds numeric range" {
		t.Fatalf("overflow error = %v", err)
	}
}

func TestCodexVersionGates(t *testing.T) {
	for version, want := range map[string]bool{
		"0.163.0": true, " codex-cli 0.163.0\n": true, "v0.170.2": true, "codex-cli v1.0.0": true,
		"0.162.9": false, "0.163.0-alpha.1": false, "codex-cli 0.163.0 (build)": false, "": false, "garbage": false,
	} {
		if CodexSupportsDirectTools(version) != want || CodexSupportsPermissionHook(version) != want {
			t.Fatalf("gate(%q) != %v", version, want)
		}
	}
}

func TestProbeVersionWithFixture(t *testing.T) {
	ctx := context.Background()
	version, err := ProbeVersion(ctx, fixtureInvocation(t, "print", map[string]string{"FIXTURE_STDOUT": "setup banner\ncodex-cli 0.151.2\n"}))
	if err != nil || version != "codex-cli 0.151.2" {
		t.Fatalf("version = %q, %v", version, err)
	}
	if _, err := ProbeVersion(ctx, fixtureInvocation(t, "print", nil)); err == nil {
		t.Fatal("empty output accepted")
	}
	if _, err := ProbeVersion(ctx, fixtureInvocation(t, "print", map[string]string{"FIXTURE_STDOUT": "1.2.3\n", "FIXTURE_EXIT": "4"})); err == nil {
		t.Fatal("non-zero exit accepted")
	}
	deadline, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := ProbeVersion(deadline, fixtureInvocation(t, "block", nil)); err == nil {
		t.Fatal("blocked probe succeeded")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("blocked probe took %s", elapsed)
	}
}

func TestProbeVersionMissingExecutable(t *testing.T) {
	if _, err := ProbeVersion(context.Background(), NewInvocation(filepath.Join(t.TempDir(), "missing"), nil)); err == nil {
		t.Fatal("missing executable accepted")
	}
}

func TestExplainExecError(t *testing.T) {
	if ExplainExecError(nil) != nil {
		t.Fatal("nil must stay nil")
	}
	cause := &exec.Error{Name: "codex", Err: &os.PathError{Op: "fork/exec", Path: "/x/codex", Err: syscall.ENOEXEC}}
	wrapped := errors.Join(errors.New("start"), cause)
	explained := ExplainExecError(wrapped)
	if !errors.Is(explained, syscall.ENOEXEC) || !strings.Contains(explained.Error(), "reinstall") {
		t.Fatalf("explained = %v", explained)
	}
	if again := ExplainExecError(explained); again != explained { //nolint:errorlint // the same error value must come back, not an equal one
		t.Fatal("explained error was wrapped twice")
	}
	notExist := &os.PathError{Op: "open", Path: "/missing", Err: os.ErrNotExist}
	if got := ExplainExecError(notExist); got != error(notExist) { //nolint:errorlint // the same error value must come back, not an equal one
		t.Fatal("unrelated error was changed")
	}
}
