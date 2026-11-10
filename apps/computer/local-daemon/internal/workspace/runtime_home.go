package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Authentication checks cannot make a newly arriving Operation fail its home claim.
var claudeAuthCheckMu sync.Mutex

var ErrRuntimeHomeInUse = errors.New("Runtime home is already in use")

var activeRuntimeHomes = struct {
	sync.Mutex
	paths map[string]struct{}
}{paths: make(map[string]struct{})}

type RuntimeHomeIdentity struct {
	TenantID     string `json:"tenant_id"`
	OwnerActorID string `json:"owner_actor_id"`
	AgentID      string `json:"agent_id"`
	ScopeID      string `json:"scope_id"`
	ProviderType string `json:"provider_type"`
}

type RuntimeHome struct {
	Path string
	// ConfigArgs are Codex `-c` overrides the daemon owns for this home (the
	// sandbox policy). They must be added to every Codex launch; they are never
	// written to the home's config.toml.
	ConfigArgs []string
	// ConfigDigest and SkillDigest identify the configuration and Skills the
	// Daemon projected into a Codex home.
	ConfigDigest string
	SkillDigest  string
	lock         *os.File
	claimPath    string
	once         sync.Once
}

// userHome is the Computer user's HOME used for `.agents/skills` inheritance;
// empty falls back to the parent of sharedHome. The home's models cache is
// seeded from the other Context homes, the source home and modelsCacheHomes.
func PrepareCodexRuntimeHome(ctx context.Context, root, sharedHome string, identity RuntimeHomeIdentity, codexVersion string, logger *slog.Logger, userHome string, modelsCacheHomes ...string) (*RuntimeHome, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(sharedHome) || identity.ProviderType != "codex" {
		return nil, errors.New("Codex Runtime home source or identity is invalid")
	}
	home, err := claimRuntimeHome(root, identity)
	if err != nil {
		return nil, err
	}
	projection, err := PrepareCodexHome(home.Path, CodexHomeOptions{
		SharedHome: sharedHome, UserHome: userHome, CodexVersion: codexVersion,
		ModelsCache: &CodexModelsCachePeers{Roots: []string{filepath.Dir(home.Path)}, Homes: modelsCacheHomes},
	}, logger)
	if err != nil {
		_ = home.Close()
		return nil, err
	}
	home.ConfigArgs, home.ConfigDigest, home.SkillDigest = projection.Args, projection.ConfigDigest, projection.SkillDigest
	if err := ctx.Err(); err != nil {
		_ = home.Close()
		return nil, err
	}
	return home, nil
}

func PrepareClaudeRuntimeHome(ctx context.Context, root string, identity RuntimeHomeIdentity) (*RuntimeHome, error) {
	claudeAuthCheckMu.Lock()
	defer claudeAuthCheckMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if identity.ProviderType != "claude" {
		return nil, errors.New("Claude Runtime home identity is invalid")
	}
	home, err := claimRuntimeHome(root, identity)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(home.Path, "sessions"), 0o700); err != nil {
		_ = home.Close()
		return nil, err
	}
	// The authentication check probes the most recently used homes first.
	now := time.Now()
	if err := os.Chtimes(home.Path, now, now); err != nil {
		_ = home.Close()
		return nil, err
	}
	return home, nil
}

func claimRuntimeHome(root string, identity RuntimeHomeIdentity) (*RuntimeHome, error) {
	if err := validateRuntimeHomeIdentity(root, identity); err != nil {
		return nil, err
	}
	digest, err := runtimeHomeDigest(identity)
	if err != nil {
		return nil, err
	}
	providerRoot := filepath.Join(root, identity.ProviderType)
	if err := os.MkdirAll(providerRoot, 0o700); err != nil {
		return nil, fmt.Errorf("create Runtime home root: %w", err)
	}
	if err := os.Chmod(providerRoot, 0o700); err != nil { //nolint:gosec // owner-only directory mode; gosec expects a file mode for Chmod
		return nil, fmt.Errorf("protect Runtime home root: %w", err)
	}
	homePath := filepath.Join(providerRoot, digest)
	if err := os.MkdirAll(homePath, 0o700); err != nil {
		return nil, fmt.Errorf("create Runtime home: %w", err)
	}
	if err := os.Chmod(homePath, 0o700); err != nil { //nolint:gosec // owner-only directory mode; gosec expects a file mode for Chmod
		return nil, fmt.Errorf("protect Runtime home: %w", err)
	}
	return claimRuntimeHomePath(homePath)
}

func claimRuntimeHomePath(homePath string) (*RuntimeHome, error) {
	activeRuntimeHomes.Lock()
	if _, claimed := activeRuntimeHomes.paths[homePath]; claimed {
		activeRuntimeHomes.Unlock()
		return nil, ErrRuntimeHomeInUse
	}
	activeRuntimeHomes.paths[homePath] = struct{}{}
	activeRuntimeHomes.Unlock()
	lock, err := LockRuntimeHome(homePath)
	if err != nil {
		activeRuntimeHomes.Lock()
		delete(activeRuntimeHomes.paths, homePath)
		activeRuntimeHomes.Unlock()
		if errors.Is(err, os.ErrExist) {
			return nil, ErrRuntimeHomeInUse
		}
		return nil, fmt.Errorf("claim Runtime home: %w", err)
	}
	return &RuntimeHome{Path: homePath, lock: lock, claimPath: homePath}, nil
}

func (h *RuntimeHome) Close() error {
	if h == nil {
		return nil
	}
	h.once.Do(func() {
		ReleaseRuntimeHomeLock(h.lock)
		h.lock = nil
		activeRuntimeHomes.Lock()
		delete(activeRuntimeHomes.paths, h.claimPath)
		activeRuntimeHomes.Unlock()
	})
	return nil
}

func CodexSourceHome(environment map[string]string) (string, error) {
	value := strings.TrimSpace(environment["CODEX_HOME"])
	if value == "" {
		home := strings.TrimSpace(environment["HOME"])
		if home == "" {
			return "", errors.New("local Codex source home requires HOME or CODEX_HOME")
		}
		value = filepath.Join(home, ".codex")
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("resolve local Codex source home: %w", err)
	}
	return filepath.Clean(absolute), nil
}

func validateRuntimeHomeIdentity(root string, identity RuntimeHomeIdentity) error {
	if !filepath.IsAbs(root) {
		return errors.New("Runtime home root must be absolute")
	}
	if identity.TenantID == "" || identity.OwnerActorID == "" || identity.AgentID == "" ||
		identity.ScopeID == "" || (identity.ProviderType != "codex" && identity.ProviderType != "claude" && identity.ProviderType != "pi") {
		return errors.New("Runtime home identity is incomplete")
	}
	return nil
}

func runtimeHomeDigest(identity RuntimeHomeIdentity) (string, error) {
	encoded, err := json.Marshal(identity)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// RuntimeHomePath resolves the stable owner-scoped Runtime home without
// creating or claiming it. It is used by read-only inspection paths.
func RuntimeHomePath(root string, identity RuntimeHomeIdentity) (string, error) {
	if err := validateRuntimeHomeIdentity(root, identity); err != nil {
		return "", err
	}
	digest, err := runtimeHomeDigest(identity)
	if err != nil {
		return "", err
	}
	providerRoot := filepath.Join(root, identity.ProviderType)
	return filepath.Join(providerRoot, digest), nil
}
