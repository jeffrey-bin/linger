package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

func TestBrowserSocketDirectoryFitsUnixLimitAndFollowsOperation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix socket path limit")
	}
	longTemp := filepath.Join(t.TempDir(), strings.Repeat("private-operation-", 8))
	if err := os.MkdirAll(longTemp, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(Options{StateDirectory: t.TempDir(), NodePath: executable, PlaywrightEntry: filepath.Join(t.TempDir(), "fixture.js"), Environment: map[string]string{"TMPDIR": longTemp, "PWTEST_SOCKETS_DIR": "/not-owned"}})
	if err != nil {
		t.Fatal(err)
	}
	m.env = append(m.env, "LINGER_LOCAL_TOOL_FIXTURE=browser-socket")
	var paths []string
	for range 2 {
		ctx, cancel := context.WithCancel(t.Context())
		op := &operation{manager: m, spec: provider.OperationSpec{WorkingDirectory: t.TempDir()}, directory: browserPrivateTestDir(t), ctx: ctx, cancel: cancel}
		c, err := op.startBrowser(ctx, "http://127.0.0.1:1", "catalog")
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		op.browser = c
		m.operations[op] = true
		t.Cleanup(func() { _ = op.close() })
		directory := op.playwrightSocketsDir
		paths = append(paths, directory)
		if err := privatefs.CheckPath(directory, "directory", true); err != nil {
			t.Fatal(err)
		}
		result, err := c.request(ctx, "tools/call", map[string]any{"name": "browser_snapshot", "arguments": map[string]any{}})
		if err != nil {
			t.Fatal(err)
		}
		var paths struct {
			SocketRoot string `json:"socket_root"`
			TempRoot   string `json:"temp_root"`
		}
		if json.Unmarshal(result, &paths) != nil || paths.SocketRoot != directory || paths.TempRoot != longTemp {
			t.Fatalf("child did not get its private socket root and unchanged TMPDIR: %s", result)
		}
		if err := op.close(); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(directory); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("confirmed close retained socket directory: %v", err)
		}
	}
	if paths[0] == paths[1] {
		t.Fatal("Operations shared a Playwright socket namespace")
	}
	if _, err := os.Stat(longTemp); err != nil {
		t.Fatalf("operation removed the caller's TMPDIR: %v", err)
	}
}

func TestBrowserSocketDirectoryRetainedForUnknownChildCleanup(t *testing.T) {
	for _, catalog := range []bool{false, true} {
		t.Run(map[bool]string{false: "active", true: "catalog"}[catalog], func(t *testing.T) {
			directory, err := os.MkdirTemp("", "linger-pw-retain-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(directory)
			client := fixtureClient(t, "image", "")
			if err := client.close(); err != nil {
				t.Fatal(err)
			}
			client.mu.Lock()
			client.err = errors.New("fixture child cleanup is unknown")
			client.mu.Unlock()
			// The real child has exited; only this fixture's receipt is made unknown.
			defer func() { client.mu.Lock(); client.err = nil; client.mu.Unlock() }()
			m := &Manager{operations: map[*operation]bool{}}
			op := &operation{manager: m, cancel: func() {}, directory: browserPrivateTestDir(t), playwrightSocketsDir: directory}
			if catalog {
				op.browserCatalog = client
			} else {
				op.browser = client
			}
			op.cua = &cuaSession{op: op, client: fixtureClient(t, "image", "")}
			m.operations[op] = true
			if err := op.close(); err == nil {
				t.Fatal("unknown child cleanup was accepted")
			}
			if _, err := os.Stat(directory); err != nil {
				t.Fatalf("unknown child lost its socket directory: %v", err)
			}
			if !m.operations[op] {
				t.Fatal("unknown Operation lost its owner")
			}
			m.retryCleanup()
			if _, err := os.Stat(directory); err != nil || !m.operations[op] {
				t.Fatalf("Cua recovery released a browser with unknown cleanup: %v", err)
			}
			client.mu.Lock()
			client.err = nil
			client.mu.Unlock()
			m.retryCleanup()
			if _, err := os.Stat(directory); !errors.Is(err, os.ErrNotExist) || m.operations[op] {
				t.Fatalf("confirmed original cleanup retained its socket directory or owner: %v", err)
			}
		})
	}
}

func TestBrowserSocketDirectoryRetainsFailedInitializationOwner(t *testing.T) {
	// Every file exists, so installation checks pass, but the Node path cannot
	// be executed: the discovery child fails after its owner was created.
	tools := t.TempDir()
	node, entry, cua := filepath.Join(tools, "unexecutable-node"), filepath.Join(tools, "fixture.js"), filepath.Join(tools, "cua-driver")
	for _, path := range []string{node, entry, cua} {
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m, err := New(Options{StateDirectory: t.TempDir(), NodePath: node, PlaywrightEntry: entry, CuaPath: cua})
	if err != nil {
		t.Fatal(err)
	}
	if m.journal, err = openJournal(filepath.Join(t.TempDir(), "action.json")); err != nil {
		t.Fatal(err)
	}
	var opens atomic.Int32
	m.openCuaSession = fakeCuaOpen(&opens, nil)
	err = m.Bind(t.Context(), provider.OperationSpec{AgentID: "fixture", WorkingDirectory: t.TempDir()}, mcpproxy.OperationIdentity{OperationID: "failed-init", ExecutionLeaseID: "lease"}, nil)
	if !errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) || len(m.operations) != 1 {
		t.Fatalf("startup failure lost its cleanup result or owner: %v, owners=%d", err, len(m.operations))
	}
	for op := range m.operations {
		defer os.RemoveAll(op.playwrightSocketsDir)
		if op.browserCatalog == nil {
			t.Fatal("initialization failure lost the original client")
		}
		if _, err := os.Stat(op.playwrightSocketsDir); err != nil {
			t.Fatalf("initialization failure lost the socket directory: %v", err)
		}
		select {
		case <-op.browserCatalog.exited:
		default:
			t.Fatal("failed launch has not settled")
		}
	}
}

func TestBrowserInitializationCleanFailureCanRetry(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{options: Options{NodePath: executable, PlaywrightEntry: filepath.Join(t.TempDir(), "fixture.js")}, env: []string{"LINGER_LOCAL_TOOL_FIXTURE=invalid-initialize"}}
	op := &operation{manager: m, spec: provider.OperationSpec{WorkingDirectory: t.TempDir()}, directory: browserPrivateTestDir(t), cancel: func() {}}
	defer op.close()
	op.browser, err = op.startBrowser(t.Context(), "http://127.0.0.1:1", "active")
	if err == nil || errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) || op.browser != nil {
		t.Fatalf("clean initialization failure retained a closed client: %v", err)
	}
	m.env = []string{"LINGER_LOCAL_TOOL_FIXTURE=image"}
	op.browser, err = op.startBrowser(t.Context(), "http://127.0.0.1:1", "active")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := op.browser.tools(t.Context()); err != nil {
		t.Fatalf("clean failure prevented a later successful initialization: %v", err)
	}
}

func TestBrowserActiveInitializationFailureFollowsCleanupReceipt(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "unknown"}[unknown], func(t *testing.T) {
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			m := &Manager{options: Options{NodePath: executable, PlaywrightEntry: filepath.Join(t.TempDir(), "fixture.js")}, env: []string{"LINGER_LOCAL_TOOL_FIXTURE=invalid-initialize"}, operations: map[*operation]bool{}}
			op := &operation{manager: m, spec: provider.OperationSpec{AgentID: "fixture", WorkingDirectory: t.TempDir()}, directory: browserPrivateTestDir(t), cancel: func() {}}
			defer func() { _ = op.close(); _ = os.RemoveAll(op.playwrightSocketsDir) }()
			m.journal, err = openJournal(filepath.Join(t.TempDir(), "action.json"))
			if err != nil {
				t.Fatal(err)
			}
			op.nativeBrowser = &nativeBrowser{}
			op.nativeProxy, err = openNativeCDPProxy("http://127.0.0.1:1")
			if err != nil {
				t.Fatal(err)
			}
			op.cua = &cuaSession{op: op, client: fixtureClient(t, "image", ""), label: "owned"}
			op.label = "owned"
			if unknown {
				// A failed executable launch is conservatively reported by the
				// client as unconfirmed cleanup. No browser is actually opened.
				m.options.NodePath = filepath.Join(t.TempDir(), "missing-node")
			}
			_, err = op.nativeBrowserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`))
			if err == nil || errors.Is(err, mcpproxy.ErrCleanupUnconfirmed) != unknown || m.journal.blocked() != unknown || (op.browser != nil) != unknown {
				t.Fatalf("initialization outcome was not preserved: unknown=%v, client=%v, blocked=%v, err=%v", unknown, op.browser != nil, m.journal.blocked(), err)
			}
			if unknown {
				if _, err := op.nativeBrowserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`)); err == nil {
					t.Fatal("missing cleanup receipt admitted another browser action")
				}
			} else {
				m.env = []string{"LINGER_LOCAL_TOOL_FIXTURE=image"}
				if _, err := op.nativeBrowserCall(t.Context(), "browser_snapshot", json.RawMessage(`{}`)); err != nil {
					t.Fatalf("confirmed failure prevented normal retry: %v", err)
				}
			}
		})
	}
}

// Real operations protect their state directory before storing browser config.
// Keep that prerequisite even when the invoking shell uses a group-writable umask.
func browserPrivateTestDir(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := privatefs.EnsureDir(directory); err != nil {
		t.Fatal(err)
	}
	return directory
}
