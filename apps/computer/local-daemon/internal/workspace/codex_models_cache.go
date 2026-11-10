package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Codex refetches its model catalog with a blocking GET /models when its home
// has no models_cache.json fetched within the last five minutes. Every Context,
// model session and one-shot model call has its own home, so each would pay
// that fetch on its first thread. A home is instead seeded with the newest
// cache another home of the same account and Codex version holds, stamped as
// fetched now: app-server refreshes the catalog online in the background as
// soon as it starts, so the stamp only spares the blocking fetch. Codex still
// checks the copied cache's client_version and identity itself.
const (
	codexModelsCacheName          = "models_cache.json"
	codexModelsCacheMaxBytes      = 8 << 20
	codexModelsCacheMaxCandidates = 8
	// codexModelsCacheTTL is how long Codex treats a fetched catalog as fresh.
	codexModelsCacheTTL = 5 * time.Minute
)

// CodexModelsCachePeers names the Codex homes on this Computer whose models
// cache a new home may reuse. The user's source home is always one of them.
type CodexModelsCachePeers struct {
	// Roots hold Codex homes as their direct children.
	Roots []string
	// Homes are single Codex homes.
	Homes []string
}

// CodexRuntimeHomesDir is the directory under a Runtime home root that holds
// every Context's Codex home.
func CodexRuntimeHomesDir(runtimeHomeRoot string) string {
	return filepath.Join(runtimeHomeRoot, "codex")
}

type codexAuthIdentity struct{ mode, account string }

type codexModelsCacheCandidate struct {
	path    string
	modTime time.Time
}

type codexModelsCacheEntry struct {
	data      []byte
	fetchedAt time.Time
}

type codexModelsCacheReport struct {
	outcome      string
	hasCandidate bool
	cacheAge     time.Duration
	hasOwn       bool
	ownAge       time.Duration
}

// seedCodexModelsCache is best effort. It writes at most one models_cache.json
// into home and logs exactly one record, at Info only when it wrote or failed;
// it never fails the caller.
func seedCodexModelsCache(root *os.Root, home, sourceHome, codexVersion string, peers CodexModelsCachePeers, logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	var report codexModelsCacheReport
	err := planCodexModelsCacheSeed(root, home, sourceHome, codexVersion, peers, time.Now(), &report)
	if err != nil {
		report.outcome = "error"
	}
	attrs := []any{"outcome", report.outcome}
	if report.hasCandidate {
		attrs = append(attrs, "cache_age_ms", report.cacheAge.Milliseconds())
	}
	if report.hasOwn {
		attrs = append(attrs, "own_cache_age_ms", report.ownAge.Milliseconds())
	}
	level := slog.LevelDebug
	if err != nil {
		attrs = append(attrs, "error", err.Error())
		level = slog.LevelInfo
	}
	if report.outcome == "seeded" || report.outcome == "renewed" {
		level = slog.LevelInfo
	}
	logger.Log(context.Background(), level, "codex models cache seed", attrs...)
}

func planCodexModelsCacheSeed(root *os.Root, home, sourceHome, codexVersion string, peers CodexModelsCachePeers, now time.Time, report *codexModelsCacheReport) error {
	identity, ok := readCodexAuthIdentity(filepath.Join(home, "auth.json"))
	if !ok {
		report.outcome = "no_auth"
		return nil
	}
	version := codexClientVersion(codexVersion)
	own, ownOK := readCodexModelsCache(func() (*os.File, error) { return root.Open(codexModelsCacheName) }, version)
	if ownOK {
		report.hasOwn, report.ownAge = true, now.Sub(own.fetchedAt)
		if report.ownAge < codexModelsCacheTTL {
			report.outcome = "own_fresh"
			return nil
		}
	}
	if sourceHome != "" {
		peers.Homes = append(slices.Clone(peers.Homes), sourceHome)
	}
	// Candidates are newest first by mtime, which Codex sets when it writes the
	// cache; the first usable one is the newest and the rest are never read.
	var best *codexModelsCacheEntry
	for _, candidate := range listCodexModelsCacheCandidates(home, peers) {
		peerDir := filepath.Dir(candidate.path)
		if peer, ok := readCodexAuthIdentity(filepath.Join(peerDir, "auth.json")); !ok || peer != identity {
			continue
		}
		if entry, ok := readCodexModelsCache(func() (*os.File, error) { return os.Open(candidate.path) }, version); ok {
			best = &entry
			break
		}
	}
	outcome := "seeded"
	switch {
	case best != nil:
		report.hasCandidate, report.cacheAge = true, now.Sub(best.fetchedAt)
		if ownOK && own.fetchedAt.After(best.fetchedAt) {
			best, outcome = &own, "renewed"
		}
	case ownOK:
		best, outcome = &own, "renewed"
	default:
		report.outcome = "no_candidate"
		return nil
	}
	data, err := stampCodexModelsCache(best.data, now)
	if err != nil {
		return err
	}
	if err := replaceProjectionFile(root, codexModelsCacheName, data); err != nil {
		return err
	}
	report.outcome = outcome
	return nil
}

// stampCodexModelsCache returns the cache with fetched_at set to now and every
// other field kept as it was.
func stampCodexModelsCache(data []byte, now time.Time) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	stamp, err := json.Marshal(now.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	fields["fetched_at"] = stamp
	return json.Marshal(fields)
}

// codexClientVersion is the bare version Codex writes as a cache's
// client_version; a probed version may carry the "codex-cli " banner.
func codexClientVersion(version string) string {
	return strings.TrimPrefix(strings.TrimSpace(version), "codex-cli ")
}

// readCodexAuthIdentity returns the account identity of a Codex auth.json. Its
// contents are never logged.
func readCodexAuthIdentity(path string) (codexAuthIdentity, bool) {
	data, err := readCappedFile(func() (*os.File, error) { return os.Open(path) }, codexModelsCacheMaxBytes)
	if err != nil {
		return codexAuthIdentity{}, false
	}
	var auth struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			AccountID string `json:"account_id"`
		} `json:"tokens"`
	}
	if json.Unmarshal(data, &auth) != nil || auth.AuthMode == "" || auth.Tokens.AccountID == "" {
		return codexAuthIdentity{}, false
	}
	return codexAuthIdentity{mode: auth.AuthMode, account: auth.Tokens.AccountID}, true
}

// listCodexModelsCacheCandidates stats the peer homes and keeps the newest few
// by mtime. Symlinks and non-directories are not homes, and home itself is
// never its own candidate.
func listCodexModelsCacheCandidates(home string, peers CodexModelsCachePeers) []codexModelsCacheCandidate {
	homes := slices.Clone(peers.Homes)
	for _, parent := range peers.Roots {
		entries, err := os.ReadDir(parent)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				homes = append(homes, filepath.Join(parent, entry.Name()))
			}
		}
	}
	seen := map[string]bool{filepath.Clean(home): true}
	var found []codexModelsCacheCandidate
	for _, peer := range homes {
		peer = filepath.Clean(peer)
		if peer == "" || seen[peer] {
			continue
		}
		seen[peer] = true
		path := filepath.Join(peer, codexModelsCacheName)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		found = append(found, codexModelsCacheCandidate{path: path, modTime: info.ModTime()})
	}
	slices.SortFunc(found, func(a, b codexModelsCacheCandidate) int { return b.modTime.Compare(a.modTime) })
	if len(found) > codexModelsCacheMaxCandidates {
		found = found[:codexModelsCacheMaxCandidates]
	}
	return found
}

func readCodexModelsCache(open func() (*os.File, error), version string) (codexModelsCacheEntry, bool) {
	data, err := readCappedFile(open, codexModelsCacheMaxBytes)
	if err != nil {
		return codexModelsCacheEntry{}, false
	}
	fetchedAt, ok := validCodexModelsCache(data, version)
	return codexModelsCacheEntry{data: data, fetchedAt: fetchedAt}, ok
}

// validCodexModelsCache checks only the fields that select a cache. An empty
// version accepts any client_version.
func validCodexModelsCache(data []byte, version string) (time.Time, bool) {
	var header struct {
		FetchedAt     string `json:"fetched_at"`
		ClientVersion string `json:"client_version"`
	}
	if json.Unmarshal(data, &header) != nil || header.ClientVersion == "" {
		return time.Time{}, false
	}
	if version != "" && header.ClientVersion != version {
		return time.Time{}, false
	}
	fetchedAt, err := time.Parse(time.RFC3339Nano, header.FetchedAt)
	if err != nil {
		return time.Time{}, false
	}
	return fetchedAt, true
}

// readCappedFile reads a regular file no larger than limit bytes. The opener
// decides whether links are followed; projected auth.json is a link.
func readCappedFile(open func() (*os.File, error), limit int64) ([]byte, error) {
	file, err := open()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("file exceeds size limit")
	}
	return data, nil
}
