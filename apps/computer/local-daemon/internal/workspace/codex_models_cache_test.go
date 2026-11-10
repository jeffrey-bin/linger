package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const seedAccountAuth = `{"auth_mode":"chatgpt","tokens":{"account_id":"acct-A"}}`

type seedFixture struct {
	codexRoot string
	home      string
	opts      CodexHomeOptions
	now       time.Time
}

func newSeedFixture(t *testing.T) seedFixture {
	t.Helper()
	parent := t.TempDir()
	shared := filepath.Join(parent, "personal")
	if err := os.Mkdir(shared, 0700); err != nil {
		t.Fatal(err)
	}
	projectionWrite(t, filepath.Join(shared, "auth.json"), seedAccountAuth)
	codexRoot := filepath.Join(parent, "codex")
	return seedFixture{
		codexRoot: codexRoot,
		home:      filepath.Join(codexRoot, "new-context"),
		opts: CodexHomeOptions{
			SharedHome: shared, UserHome: parent, CodexVersion: "0.153.4",
			ModelsCache: &CodexModelsCachePeers{Roots: []string{codexRoot}},
		},
		now: time.Now(),
	}
}

func seedCache(fetchedAt time.Time, clientVersion string) string {
	return `{"client_version":"` + clientVersion + `","etag":"W/\"` + fetchedAt.UTC().Format(time.RFC3339Nano) + `\"","fetched_at":"` + fetchedAt.UTC().Format(time.RFC3339Nano) + `","models":[]}`
}

// assertSeededFrom checks that the home's cache is source with fetched_at
// stamped at or after notBefore and every other field unchanged.
func assertSeededFrom(t *testing.T, home, source string, notBefore time.Time) {
	t.Helper()
	var got, want map[string]json.RawMessage
	if err := json.Unmarshal([]byte(projectionRead(t, filepath.Join(home, codexModelsCacheName))), &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(source), &want); err != nil {
		t.Fatal(err)
	}
	var stamp string
	if err := json.Unmarshal(got["fetched_at"], &stamp); err != nil {
		t.Fatal(err)
	}
	fetchedAt, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil || fetchedAt.Before(notBefore.Truncate(time.Second)) || time.Since(fetchedAt) > time.Minute {
		t.Fatalf("fetched_at = %q, want now", stamp)
	}
	delete(got, "fetched_at")
	delete(want, "fetched_at")
	if len(got) != len(want) {
		t.Fatalf("seeded fields = %v, want %v", got, want)
	}
	for key, value := range want {
		if string(got[key]) != string(value) {
			t.Fatalf("seeded %s = %s, want %s", key, got[key], value)
		}
	}
}

// makeSibling writes a sibling runtime home with an auth file and optional cache,
// then sets the cache mtime so tests control the newest-first order.
func makeSibling(t *testing.T, root, name, auth, cache string, mtime time.Time) string {
	t.Helper()
	dir := filepath.Join(root, name)
	projectionWrite(t, filepath.Join(dir, "auth.json"), auth)
	if cache == "" {
		return dir
	}
	path := filepath.Join(dir, codexModelsCacheName)
	projectionWrite(t, path, cache)
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return dir
}

func seedPrepare(t *testing.T, fixture seedFixture) string {
	t.Helper()
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	if _, err := PrepareCodexHome(fixture.home, fixture.opts, logger); err != nil {
		t.Fatalf("PrepareCodexHome failed: %v", err)
	}
	if n := strings.Count(logs.String(), "codex models cache seed"); n != 1 {
		t.Fatalf("expected exactly one seed record, got %d: %s", n, logs.String())
	}
	return logs.String()
}

func assertSeedOutcome(t *testing.T, logs, outcome string) {
	t.Helper()
	if !strings.Contains(logs, "outcome="+outcome) {
		t.Fatalf("want outcome=%s in: %s", outcome, logs)
	}
}

func TestCodexModelsCacheSeedsNewestMatchingSiblingStampedNow(t *testing.T) {
	fixture := newSeedFixture(t)
	older := seedCache(fixture.now.Add(-time.Hour), "0.153.4")
	newest := seedCache(fixture.now.Add(-10*time.Minute), "0.153.4")
	makeSibling(t, fixture.codexRoot, "a", seedAccountAuth, older, fixture.now.Add(-2*time.Hour))
	makeSibling(t, fixture.codexRoot, "b", seedAccountAuth, newest, fixture.now.Add(-time.Minute))
	makeSibling(t, fixture.codexRoot, "other", `{"auth_mode":"chatgpt","tokens":{"account_id":"acct-B"}}`, seedCache(fixture.now, "0.153.4"), fixture.now)
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "seeded")
	path := filepath.Join(fixture.home, codexModelsCacheName)
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm() != 0600) {
		t.Fatalf("seeded cache mode=%v, want regular 0600", info.Mode())
	}
	if runtime.GOOS == "windows" {
		if err := privatefs.CheckPath(path, "file", true); err != nil {
			t.Fatalf("seeded cache ACL: %v", err)
		}
	}
	assertSeededFrom(t, fixture.home, newest, fixture.now)
	if !strings.Contains(logs, "level=INFO") {
		t.Fatalf("a seeded home is not logged at Info: %s", logs)
	}
}

func TestCodexModelsCacheIgnoresOtherAccountOrAuthMode(t *testing.T) {
	fixture := newSeedFixture(t)
	makeSibling(t, fixture.codexRoot, "other-account", `{"auth_mode":"chatgpt","tokens":{"account_id":"acct-B"}}`, seedCache(fixture.now, "0.153.4"), fixture.now)
	makeSibling(t, fixture.codexRoot, "api-key", `{"auth_mode":"apikey","tokens":{"account_id":"acct-A"}}`, seedCache(fixture.now, "0.153.4"), fixture.now)
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "no_candidate")
	if _, err := os.Stat(filepath.Join(fixture.home, codexModelsCacheName)); !os.IsNotExist(err) {
		t.Fatalf("cache seeded from a mismatched identity: %v", err)
	}
}

func TestCodexModelsCacheIgnoresClientVersionMismatch(t *testing.T) {
	fixture := newSeedFixture(t)
	makeSibling(t, fixture.codexRoot, "old-cli", seedAccountAuth, seedCache(fixture.now, "0.150.0"), fixture.now)
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "no_candidate")
	if _, err := os.Stat(filepath.Join(fixture.home, codexModelsCacheName)); !os.IsNotExist(err) {
		t.Fatalf("cache seeded across client_version mismatch: %v", err)
	}
}

func TestCodexModelsCacheSkipsCorruptAndOversizedCandidates(t *testing.T) {
	fixture := newSeedFixture(t)
	valid := seedCache(fixture.now.Add(-time.Hour), "0.153.4")
	makeSibling(t, fixture.codexRoot, "corrupt", seedAccountAuth, `{"fetched_at":`, fixture.now.Add(-time.Minute))
	oversized := `{"fetched_at":"` + fixture.now.UTC().Format(time.RFC3339Nano) + `","client_version":"0.153.4","pad":"` + strings.Repeat("x", codexModelsCacheMaxBytes) + `"}`
	makeSibling(t, fixture.codexRoot, "oversized", seedAccountAuth, oversized, fixture.now.Add(-2*time.Minute))
	makeSibling(t, fixture.codexRoot, "valid", seedAccountAuth, valid, fixture.now.Add(-3*time.Minute))
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "seeded")
	assertSeededFrom(t, fixture.home, valid, fixture.now)
}

func TestCodexModelsCacheKeepsAFreshOwnCache(t *testing.T) {
	fixture := newSeedFixture(t)
	makeSibling(t, fixture.codexRoot, "sibling", seedAccountAuth, seedCache(fixture.now, "0.153.4"), fixture.now)
	// The first call creates the home; its own cache is then written.
	if _, err := PrepareCodexHome(fixture.home, fixture.opts, nil); err != nil {
		t.Fatal(err)
	}
	own := seedCache(fixture.now.Add(-time.Minute), "0.153.4")
	projectionWrite(t, filepath.Join(fixture.home, codexModelsCacheName), own)
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "own_fresh")
	if got := projectionRead(t, filepath.Join(fixture.home, codexModelsCacheName)); got != own {
		t.Fatalf("fresh own cache replaced: %s", got)
	}
	if strings.Contains(logs, "level=INFO") {
		t.Fatalf("an untouched home is logged at Info: %s", logs)
	}
}

func TestCodexModelsCacheRenewsAStaleOwnCacheNewerThanEveryPeer(t *testing.T) {
	fixture := newSeedFixture(t)
	makeSibling(t, fixture.codexRoot, "sibling", seedAccountAuth, seedCache(fixture.now.Add(-time.Hour), "0.153.4"), fixture.now)
	if _, err := PrepareCodexHome(fixture.home, fixture.opts, nil); err != nil {
		t.Fatal(err)
	}
	own := seedCache(fixture.now.Add(-30*time.Minute), "0.153.4")
	projectionWrite(t, filepath.Join(fixture.home, codexModelsCacheName), own)
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "renewed")
	assertSeededFrom(t, fixture.home, own, fixture.now)
}

func TestCodexModelsCacheReplacesAStaleOwnCacheWithANewerPeer(t *testing.T) {
	fixture := newSeedFixture(t)
	peer := seedCache(fixture.now.Add(-10*time.Minute), "0.153.4")
	makeSibling(t, fixture.codexRoot, "sibling", seedAccountAuth, peer, fixture.now)
	if _, err := PrepareCodexHome(fixture.home, fixture.opts, nil); err != nil {
		t.Fatal(err)
	}
	projectionWrite(t, filepath.Join(fixture.home, codexModelsCacheName), seedCache(fixture.now.Add(-time.Hour), "0.153.4"))
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "seeded")
	assertSeededFrom(t, fixture.home, peer, fixture.now)
}

func TestCodexModelsCacheMatchesAProbedVersionBanner(t *testing.T) {
	fixture := newSeedFixture(t)
	fixture.opts.CodexVersion = "codex-cli 0.153.4"
	cache := seedCache(fixture.now.Add(-time.Hour), "0.153.4")
	makeSibling(t, fixture.codexRoot, "sibling", seedAccountAuth, cache, fixture.now)
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "seeded")
	assertSeededFrom(t, fixture.home, cache, fixture.now)
}

func TestCodexModelsCacheSeedsFromTheSourceAndNamedHomes(t *testing.T) {
	fixture := newSeedFixture(t)
	source := seedCache(fixture.now.Add(-2*time.Hour), "0.153.4")
	projectionWrite(t, filepath.Join(fixture.opts.SharedHome, codexModelsCacheName), source)
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "seeded")
	assertSeededFrom(t, fixture.home, source, fixture.now)

	// A named home outside the roots is a peer too; the newest by mtime wins.
	session := makeSibling(t, t.TempDir(), "session-home", seedAccountAuth, seedCache(fixture.now.Add(-time.Hour), "0.153.4"), fixture.now.Add(time.Minute))
	named := projectionRead(t, filepath.Join(session, codexModelsCacheName))
	fixture.opts.ModelsCache.Homes = []string{session}
	fixture.home = filepath.Join(fixture.codexRoot, "second-context")
	logs = seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "seeded")
	assertSeededFrom(t, fixture.home, named, fixture.now)
}

func TestCodexModelsCacheSeedsNothingWithoutPeers(t *testing.T) {
	fixture := newSeedFixture(t)
	makeSibling(t, fixture.codexRoot, "sibling", seedAccountAuth, seedCache(fixture.now, "0.153.4"), fixture.now)
	fixture.opts.ModelsCache = nil
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	if _, err := PrepareCodexHome(fixture.home, fixture.opts, logger); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(logs.String(), "codex models cache seed") {
		t.Fatalf("a home without peers was seeded: %s", logs.String())
	}
	if _, err := os.Stat(filepath.Join(fixture.home, codexModelsCacheName)); !os.IsNotExist(err) {
		t.Fatalf("cache written without peers: %v", err)
	}
}

func TestCodexInvokeHomeSeedsItsModelsCache(t *testing.T) {
	fixture := newSeedFixture(t)
	cache := seedCache(fixture.now.Add(-time.Hour), "0.153.4")
	makeSibling(t, fixture.codexRoot, "context", seedAccountAuth, cache, fixture.now)
	home := filepath.Join(t.TempDir(), "codex-home")
	if _, err := PrepareCodexInvokeHome(home, fixture.opts.SharedHome, "codex-cli 0.153.4", CodexModelsCachePeers{Roots: []string{fixture.codexRoot}}); err != nil {
		t.Fatal(err)
	}
	assertSeededFrom(t, home, cache, fixture.now)
}

func TestCodexRuntimeHomeSeedsFromOtherContextsAndNamedHomes(t *testing.T) {
	fixture := newSeedFixture(t)
	root := t.TempDir()
	identity := RuntimeHomeIdentity{TenantID: "tenant", OwnerActorID: "owner", AgentID: "agent", ScopeID: "scope", ProviderType: "codex"}
	cache := seedCache(fixture.now.Add(-time.Hour), "0.153.4")
	makeSibling(t, CodexRuntimeHomesDir(root), "other-context", seedAccountAuth, cache, fixture.now)
	home, err := PrepareCodexRuntimeHome(context.Background(), root, fixture.opts.SharedHome, identity, "codex-cli 0.153.4", nil, "")
	if err != nil {
		t.Fatal(err)
	}
	defer home.Close()
	assertSeededFrom(t, home.Path, cache, fixture.now)
	if filepath.Dir(home.Path) != CodexRuntimeHomesDir(root) {
		t.Fatalf("Codex Runtime home %s is outside %s", home.Path, CodexRuntimeHomesDir(root))
	}
}

func TestCodexModelsCacheNoAuthSkipsSeedingButPrepares(t *testing.T) {
	fixture := newSeedFixture(t)
	makeSibling(t, fixture.codexRoot, "sibling", seedAccountAuth, seedCache(fixture.now, "0.153.4"), fixture.now)
	if err := os.Remove(filepath.Join(fixture.opts.SharedHome, "auth.json")); err != nil {
		t.Fatal(err)
	}
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "no_auth")
	if _, err := os.Stat(filepath.Join(fixture.home, codexModelsCacheName)); !os.IsNotExist(err) {
		t.Fatalf("cache seeded without auth: %v", err)
	}
}

func TestCodexModelsCacheIgnoresUnreadableAndLinkedSiblings(t *testing.T) {
	fixture := newSeedFixture(t)
	valid := seedCache(fixture.now.Add(-time.Hour), "0.153.4")
	// Root reads through mode 0, so the unreadable sibling exists only for other users.
	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		locked := makeSibling(t, fixture.codexRoot, "locked", seedAccountAuth, "", fixture.now)
		projectionWrite(t, filepath.Join(locked, codexModelsCacheName), seedCache(fixture.now, "0.153.4"))
		if err := os.Chmod(locked, 0); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(locked, 0700) })
	}
	target := makeSibling(t, filepath.Join(fixture.codexRoot, ".."), "link-target", seedAccountAuth, seedCache(fixture.now, "0.153.4"), fixture.now)
	if err := os.MkdirAll(fixture.codexRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(target, filepath.Join(fixture.codexRoot, "linked")); err != nil {
		t.Fatal(err)
	}
	projectionWrite(t, filepath.Join(fixture.codexRoot, "plain-file"), "not a directory")
	makeSibling(t, fixture.codexRoot, "valid", seedAccountAuth, valid, fixture.now.Add(-time.Minute))
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "seeded")
	assertSeededFrom(t, fixture.home, valid, fixture.now)
}

func TestCodexModelsCacheConsidersOnlyNewestEightByMtime(t *testing.T) {
	fixture := newSeedFixture(t)
	valid := seedCache(fixture.now.Add(-time.Hour), "0.153.4")
	for i := range codexModelsCacheMaxCandidates {
		makeSibling(t, fixture.codexRoot, "corrupt-"+strings.Repeat("a", i+1), seedAccountAuth, `{"fetched_at":`, fixture.now.Add(-time.Duration(i)*time.Minute))
	}
	// The ninth-newest home is valid, but it is outside the examined window.
	makeSibling(t, fixture.codexRoot, "ninth", seedAccountAuth, valid, fixture.now.Add(-time.Duration(codexModelsCacheMaxCandidates+1)*time.Minute))
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "no_candidate")
	if _, err := os.Stat(filepath.Join(fixture.home, codexModelsCacheName)); !os.IsNotExist(err) {
		t.Fatalf("cache seeded from beyond the newest %d: %v", codexModelsCacheMaxCandidates, err)
	}
}

func TestCodexModelsCacheParsesFractionalFetchedAt(t *testing.T) {
	fixture := newSeedFixture(t)
	fetched := time.Date(2026, 10, 25, 8, 0, 0, 123456789, time.UTC)
	body := `{"fetched_at":"` + fetched.Format(time.RFC3339Nano) + `","client_version":"0.153.4"}`
	makeSibling(t, fixture.codexRoot, "fraction", seedAccountAuth, body, fixture.now)
	logs := seedPrepare(t, fixture)
	assertSeedOutcome(t, logs, "seeded")
	assertSeededFrom(t, fixture.home, body, fixture.now)
}
