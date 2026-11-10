package privatefs

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestFileLockChild(t *testing.T) {
	path := os.Getenv("LINGER_FILELOCK_FIXTURE")
	if path == "" {
		return
	}
	file, ok, err := AcquireLock(path)
	if err != nil || !ok {
		os.Exit(2)
	}
	defer ReleaseLock(file)
	_, _ = fmt.Fprintln(os.Stdout, "locked")
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}
func TestLockSurvivesContentAccessAndReleasesOnProcessExit(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "lease")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, binary, "-test.run=^TestFileLockChild$")
	child.Env = append(os.Environ(), "LINGER_FILELOCK_FIXTURE="+path)
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); _ = child.Process.Kill(); _ = child.Wait() }()
	ready := bufio.NewScanner(stdout)
	if !ready.Scan() || ready.Text() != "locked" {
		t.Fatal("child did not acquire lock")
	}
	if file, ok, err := AcquireLock(path); err != nil || ok {
		ReleaseLock(file)
		t.Fatalf("competing acquire=%v %v", ok, err)
	}
	// Content I/O uses a separate file; mandatory Windows locks cannot obstruct it.
	if err := os.WriteFile(filepath.Join(root, "transcript"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	file, ok, err := AcquireLock(path)
	if err != nil || !ok {
		t.Fatalf("kernel did not release dead owner: %v", err)
	}
	ReleaseLock(file)
}
func TestLockCannotFollowLinkOrReplaceAnExclusiveClaim(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "marker")
	file, err := OpenLock(path, true)
	if err != nil {
		t.Fatal(err)
	}
	ReleaseLock(file)
	if file, err := OpenLock(path, true); err == nil {
		ReleaseLock(file)
		t.Fatal("exclusive marker replaced")
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if file, err := OpenLock(link, false); err == nil {
		ReleaseLock(file)
		t.Fatal("lock followed link")
	}
}
