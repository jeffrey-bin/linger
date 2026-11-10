package localtools

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// catalogFixture makes Playwright starts observable using the test binary as
// the MCP child. Failing makes the child refuse initialization. Cua is faked.
type catalogFixture struct {
	options Options
	counter string
	fail    string
	entry   string
}

func newCatalogFixture(t *testing.T) *catalogFixture {
	t.Helper()
	root := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	f := &catalogFixture{counter: filepath.Join(root, "starts"), fail: filepath.Join(root, "fail"), entry: filepath.Join(root, "cli.js")}
	if err := os.WriteFile(f.entry, []byte("entry"), 0o600); err != nil {
		t.Fatal(err)
	}
	cua := filepath.Join(root, "cua-driver")
	if err := os.WriteFile(cua, []byte("cua"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.options = Options{StateDirectory: filepath.Join(root, "state"), NodePath: executable, PlaywrightEntry: f.entry, CuaPath: cua}
	return f
}

func (f *catalogFixture) starts(t *testing.T) int {
	t.Helper()
	data, err := os.ReadFile(f.counter)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(data), "x")
}

func newCatalogManager(t *testing.T, f *catalogFixture) *Manager {
	t.Helper()
	m, err := New(f.options)
	if err != nil {
		t.Fatal(err)
	}
	if m.journal, err = openJournal(filepath.Join(t.TempDir(), "action.json")); err != nil {
		t.Fatal(err)
	}
	m.env = append(m.env, "LINGER_LOCAL_TOOL_FIXTURE=catalog", "LINGER_CATALOG_COUNTER="+f.counter, "LINGER_CATALOG_FAIL="+f.fail)
	m.openCuaSession = func(_ context.Context, op *operation) (*cuaSession, []tool, error) {
		return &cuaSession{op: op, client: fakeCuaClient(nil), label: "catalog"}, []tool{{Name: "click", InputSchema: json.RawMessage(`{"type":"object"}`)}}, nil
	}
	return m
}

func bindCatalog(t *testing.T, m *Manager, operationID string) (*mcpproxy.Set, error) {
	t.Helper()
	identity := mcpproxy.OperationIdentity{OperationID: operationID, ExecutionLeaseID: "lease-" + operationID}
	set, err := mcpproxy.Open(t.Context(), nil, identity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = set.Close() })
	spec := provider.OperationSpec{AgentID: "fixture", WorkingDirectory: t.TempDir()}
	return set, m.Bind(t.Context(), spec, identity, set)
}

// serverURLs returns each local MCP server URL from the Set's Codex-facing config.
func serverURLs(t *testing.T, set *mcpproxy.Set) map[string]string {
	t.Helper()
	var config struct {
		Servers map[string]struct {
			URL string `json:"url"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(set.Config(), &config); err != nil {
		t.Fatal(err)
	}
	urls := map[string]string{}
	for name, server := range config.Servers {
		urls[name] = server.URL
	}
	return urls
}

func listTools(t *testing.T, url string) []string {
	t.Helper()
	response, err := http.Post(url, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("tools/list status=%d body=%s", response.StatusCode, body)
	}
	var reply struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &reply); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range reply.Result.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	return names
}

func TestUnchangedInstallationServesCachedCatalogWithoutStartingPlaywright(t *testing.T) {
	f := newCatalogFixture(t)
	m := newCatalogManager(t, f)
	first, err := bindCatalog(t, m, "first")
	if err != nil {
		t.Fatal(err)
	}
	if got := f.starts(t); got != 1 {
		t.Fatalf("first Bind starts=%d, want one discovery child", got)
	}
	second, err := bindCatalog(t, m, "second")
	if err != nil {
		t.Fatal(err)
	}
	if got := f.starts(t); got != 1 {
		t.Fatalf("cached Bind started Playwright again: starts=%d", got)
	}
	for _, name := range []string{"computer", "browser"} {
		want := listTools(t, serverURLs(t, first)[name])
		got := listTools(t, serverURLs(t, second)[name])
		if strings.Join(got, ",") != strings.Join(want, ",") || len(got) == 0 {
			t.Fatalf("%s catalog changed: first=%v second=%v", name, want, got)
		}
	}
}

func TestChangedPlaywrightEntryInvalidatesCatalogAndFailedDiscoveryIsNotCached(t *testing.T) {
	f := newCatalogFixture(t)
	m := newCatalogManager(t, f)
	if err := os.WriteFile(f.fail, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := bindCatalog(t, m, "refused"); err == nil {
		t.Fatal("refused discovery bound tools")
	}
	if got := f.starts(t); got != 1 {
		t.Fatalf("failed discovery starts=%d, want 1", got)
	}
	if err := os.Remove(f.fail); err != nil {
		t.Fatal(err)
	}
	if _, err := bindCatalog(t, m, "recovered"); err != nil {
		t.Fatalf("failed discovery was cached: %v", err)
	}
	if got := f.starts(t); got != 2 {
		t.Fatalf("recovery after failure starts=%d, want a fresh discovery", got)
	}
	when := time.Now().Add(time.Hour)
	if err := os.Chtimes(f.entry, when, when); err != nil {
		t.Fatal(err)
	}
	if _, err := bindCatalog(t, m, "changed"); err != nil {
		t.Fatal(err)
	}
	if got := f.starts(t); got != 3 {
		t.Fatalf("changed Playwright entry was not rediscovered: starts=%d", got)
	}
}

func TestOperationToolServersStayIsolatedAfterCatalogCache(t *testing.T) {
	f := newCatalogFixture(t)
	m := newCatalogManager(t, f)
	first, err := bindCatalog(t, m, "first")
	if err != nil {
		t.Fatal(err)
	}
	second, err := bindCatalog(t, m, "second")
	if err != nil {
		t.Fatal(err)
	}
	firstURL, secondURL := serverURLs(t, first)["browser"], serverURLs(t, second)["browser"]
	if firstURL == secondURL {
		t.Fatalf("Operations share one tool authority: %s", firstURL)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if got := listTools(t, secondURL); len(got) == 0 {
		t.Fatal("closing one Operation revoked another")
	}
	response, err := http.Post(firstURL, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	if err == nil {
		defer response.Body.Close()
		if response.StatusCode != http.StatusGone && response.StatusCode != http.StatusNotFound {
			t.Fatalf("closed Operation answered with status %d", response.StatusCode)
		}
	}
}

func operationCount(m *Manager) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.operations)
}

func TestPrewarmCachesCatalogForFirstBind(t *testing.T) {
	f := newCatalogFixture(t)
	m := newCatalogManager(t, f)
	m.Prewarm(t.Context())
	if got := f.starts(t); got != 1 {
		t.Fatalf("prewarm starts=%d, want one discovery child", got)
	}
	if _, err := os.Stat(filepath.Join(f.options.StateDirectory, "computer-tools", "catalog")); !os.IsNotExist(err) {
		t.Fatalf("prewarm left its discovery directory: %v", err)
	}
	if n := operationCount(m); n != 0 {
		t.Fatalf("prewarm registered %d operations", n)
	}
	bound, err := bindCatalog(t, m, "first")
	if err != nil {
		t.Fatal(err)
	}
	if got := f.starts(t); got != 1 {
		t.Fatalf("Bind after prewarm started Playwright again: starts=%d", got)
	}
	// A normal cached Bind on a fresh manager serves the same lists.
	fresh := newCatalogManager(t, f)
	reference, err := bindCatalog(t, fresh, "reference")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"computer", "browser"} {
		want := listTools(t, serverURLs(t, reference)[name])
		got := listTools(t, serverURLs(t, bound)[name])
		if strings.Join(got, ",") != strings.Join(want, ",") || len(got) == 0 {
			t.Fatalf("%s catalog after prewarm differs: want=%v got=%v", name, want, got)
		}
	}
}

func TestFailedPrewarmIsNotCached(t *testing.T) {
	f := newCatalogFixture(t)
	m := newCatalogManager(t, f)
	if err := os.WriteFile(f.fail, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	m.Prewarm(t.Context())
	if got := f.starts(t); got != 1 {
		t.Fatalf("failed prewarm starts=%d, want 1", got)
	}
	if err := os.Remove(f.fail); err != nil {
		t.Fatal(err)
	}
	if _, err := bindCatalog(t, m, "recovered"); err != nil {
		t.Fatalf("failed prewarm was cached: %v", err)
	}
	if got := f.starts(t); got != 2 {
		t.Fatalf("Bind after failed prewarm starts=%d, want a fresh discovery", got)
	}
}

func TestConcurrentPrewarmAndBindDiscoverOnce(t *testing.T) {
	f := newCatalogFixture(t)
	m := newCatalogManager(t, f)
	done := make(chan struct{})
	go func() {
		defer close(done)
		m.Prewarm(t.Context())
	}()
	_, err := bindCatalog(t, m, "concurrent")
	<-done
	if err != nil {
		t.Fatal(err)
	}
	if got := f.starts(t); got != 1 {
		t.Fatalf("concurrent prewarm and Bind starts=%d, want exactly one discovery", got)
	}
}

func TestPrewarmWithoutNativeOrJournalStartsNothing(t *testing.T) {
	f := newCatalogFixture(t)
	m := &Manager{options: Options{StateDirectory: f.options.StateDirectory, NodePath: f.options.NodePath, PlaywrightEntry: f.options.PlaywrightEntry}}
	m.Prewarm(t.Context())
	if got := f.starts(t); got != 0 {
		t.Fatalf("prewarm without local tools started %d children", got)
	}
}
