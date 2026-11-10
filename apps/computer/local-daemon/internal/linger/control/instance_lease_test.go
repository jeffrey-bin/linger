package control

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func TestLeaseLockExcludesConcurrentDaemonAndAllowsReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), leaseLockName)
	lock, err := claim(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := claim(context.Background(), path); err == nil || err.Error() != "Local Computer Daemon is already running" {
		t.Fatalf("concurrent claim error=%v", err)
	}
	first := Owner{PID: 10, ProcessGroupID: 10, StartTime: "first", Nonce: "first-nonce"}
	lockDirectory := filepath.Join(filepath.Dir(path), lockDirectoryName)
	if err := writeOwner(lockDirectory, first); err != nil {
		t.Fatal(err)
	}
	lease := &Lease{lock: lock, lockDirectory: lockDirectory, owner: first}
	if err := lease.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lockDirectory); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("released lock directory error=%v", err)
	}
	replacement, err := claim(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	privatefs.ReleaseLock(replacement)
}

func TestOwnerMarkerMatchesExistingCLIContract(t *testing.T) {
	lockDirectory := filepath.Join(t.TempDir(), lockDirectoryName)
	want := Owner{PID: 42, ProcessGroupID: 42, StartTime: "12345", Nonce: "owner-nonce"}
	if err := writeOwner(lockDirectory, want); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(lockDirectory, ownerFileName)
	if err := privatefs.CheckPath(path, "file", true); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(content, &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 4 || keys["pid"] == nil || keys["processGroupId"] == nil || keys["startTime"] == nil || keys["nonce"] == nil {
		t.Fatalf("owner marker keys=%v", keys)
	}
	got, err := readOwner(lockDirectory)
	if err != nil || got != want {
		t.Fatalf("owner marker=%+v err=%v", got, err)
	}
}

func TestCurrentProcessIdentityUsesStableGenerationToken(t *testing.T) {
	identity, err := currentProcessIdentity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if identity.PID != os.Getpid() || identity.ProcessGroupID < 1 || identity.StartTime == "" {
		t.Fatalf("process identity=%+v", identity)
	}
	if runtime.GOOS == "darwin" {
		output, err := exec.Command("/bin/ps", "-p", strconv.Itoa(os.Getpid()), "-o", "lstart=").Output()
		if err != nil {
			t.Fatal(err)
		}
		if want := strings.TrimSpace(string(output)); identity.StartTime != want {
			t.Fatalf("process start time=%q, want CLI-compatible %q", identity.StartTime, want)
		}
	}
}

func TestReadOwnerRejectsUnsafeMarker(t *testing.T) {
	lockDirectory := filepath.Join(t.TempDir(), lockDirectoryName)
	if err := os.Mkdir(lockDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(lockDirectory, ownerFileName)
	if err := os.WriteFile(path, []byte(`{"pid":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readOwner(lockDirectory); err == nil || errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unsafe owner marker error=%v", err)
	}
}
