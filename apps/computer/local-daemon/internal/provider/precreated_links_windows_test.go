//go:build windows

package provider

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsPrecreatedDiagnosticFileLink(t *testing.T) {
	root := os.Getenv("LINGER_TEST_PROVIDER_LINK_ROOT")
	if root == "" {
		t.Skip("requires an administrator-precreated file link fixture")
	}
	dir := filepath.Join(root, "diagnostic")
	target := filepath.Join(dir, "retained")
	link := filepath.Join(dir, "runner-diagnostics.log")
	assertProviderFixtureLink(t, link, target)
	before, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	localDiagnosticLogger(dir, OperationSpec{}, nil).Info("must not write")
	after, err := os.ReadFile(target)
	if err != nil || string(after) != string(before) {
		t.Fatalf("linked diagnostic target changed: %v", err)
	}
}

func TestWindowsPrecreatedModelWorkspaceFileLink(t *testing.T) {
	root := os.Getenv("LINGER_TEST_PROVIDER_LINK_ROOT")
	if root == "" {
		t.Skip("requires an administrator-precreated file link fixture")
	}
	target := filepath.Join(root, "model", "retained")
	link := filepath.Join(root, "model", "prepared-link")
	assertProviderFixtureLink(t, link, target)
	before, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newCodexInvokeFixture(t, func(_ context.Context, command *exec.Cmd) error {
		if err := os.Rename(link, filepath.Join(command.Dir, "link")); err != nil {
			return err
		}
		return os.WriteFile(argValue(command.Args, "-o"), []byte("done"), 0o600)
	})
	result := fixture.invoker.Invoke(context.Background(), ModelInvokeRequest{RuntimeType: "codex", Mode: ModelInvokeWorkspace, Input: "test", Timeout: time.Minute})
	if result.Outcome != ModelInvokeCompleted || len(result.WorkspaceFiles) != 0 {
		t.Fatalf("result = %+v", result)
	}
	after, err := os.ReadFile(target)
	if err != nil || string(after) != string(before) {
		t.Fatalf("linked model target changed: %v", err)
	}
}

func assertProviderFixtureLink(t *testing.T, link, target string) {
	t.Helper()
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("fixture link %s: %v", link, err)
	}
	actual, err := filepath.EvalSymlinks(link)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	if actual != expected {
		t.Fatalf("fixture target = %q, want %q", actual, expected)
	}
}
