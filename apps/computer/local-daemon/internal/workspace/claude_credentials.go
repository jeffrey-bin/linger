package workspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Test seams never read or change the developer's login.
var claudeKeychainRead = readClaudeKeychain
var claudeKeychainRemove = removeClaudeKeychain

// Reconcile both stores Claude actually reads. A scoped Keychain entry on
// macOS shadows .credentials.json, including when its OAuth tokens are empty.
// retireResident stops a parked Claude process on configRoot before any store
// changes; nil means no process can be using configRoot.
func configureClaudeCredentials(configRoot string, environment map[string]string, retireResident func() error) error {
	source := environment["CLAUDE_CONFIG_DIR"]
	keychainRoot := source // Empty selects Claude's default, unsuffixed login.
	if source == "" {
		source = filepath.Join(environment["HOME"], ".claude")
	}
	if err := inheritClaudeAuthEnvironment(source, environment); err != nil {
		return err
	}
	if source != configRoot {
		var content []byte
		if !explicitClaudeAuthEnvironment(environment) {
			var err error
			content, err = claudeKeychainRead(keychainRoot)
			if err != nil {
				return err
			}
			if len(content) == 0 {
				content, err = os.ReadFile(filepath.Join(source, ".credentials.json"))
				if err != nil && !errors.Is(err, os.ErrNotExist) {
					return err
				}
			}
			if len(content) != 0 && !json.Valid(content) {
				return errors.New("Claude credential is invalid")
			}
		}
		if err := adoptClaudeCredential(configRoot, content, retireResident); err != nil {
			return err
		}
	}
	environment["CLAUDE_CONFIG_DIR"] = configRoot
	return nil
}

// Track source generation separately from expiry: a new login/account can
// have an equal/earlier expiry than a Context's refreshed token. If the source
// has not changed, keep Claude's newer native refresh.
func adoptClaudeCredential(configRoot string, source []byte, retireResident func() error) error {
	destination := filepath.Join(configRoot, ".credentials.json")
	marker := filepath.Join(configRoot, ".linger-auth-source.sha256")
	fingerprint := sha256.Sum256(source)
	generation := hex.EncodeToString(fingerprint[:])
	previous, err := os.ReadFile(marker)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	sourceChanged := len(previous) > 0 && string(previous) != generation
	selected := source
	existing, err := os.ReadFile(destination)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	scoped, err := claudeKeychainRead(configRoot)
	if err != nil {
		return err
	}
	if len(source) > 0 && !sourceChanged {
		for _, candidate := range [][]byte{existing, scoped} {
			if claudeCredentialUsable(candidate) && claudeCredentialExpiry(candidate) > claudeCredentialExpiry(selected) {
				selected = candidate
			}
		}
	}
	removeDestination := len(selected) == 0 && existing != nil
	writeDestination := len(selected) != 0 && !bytes.Equal(existing, selected)
	// Only remove the managed directory's stale shadow. No token enters argv.
	removeScoped := len(scoped) > 0 && (sourceChanged || !claudeCredentialUsable(scoped) || (claudeCredentialExpiry(scoped) <= claudeCredentialExpiry(selected) && !bytes.Equal(scoped, selected)) || len(selected) == 0)
	writeMarker := string(previous) != generation
	if !removeDestination && !writeDestination && !removeScoped && !writeMarker {
		return nil
	}
	// A parked process caches the login it started with and may refresh it, so
	// it is stopped before either store changes under it. Mirroring its own
	// native refresh from the scoped Keychain into the shadowed file changes
	// nothing Claude reads.
	mirrorOnly := writeDestination && bytes.Equal(scoped, selected) && !removeScoped && !writeMarker
	if retireResident != nil && !mirrorOnly {
		if err := retireResident(); err != nil {
			return err
		}
	}
	if removeDestination {
		if err := os.Remove(destination); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else if writeDestination {
		if err := writePrivateRuntimeFile(destination, selected); err != nil {
			return err
		}
	}
	if removeScoped {
		if err := claudeKeychainRemove(configRoot); err != nil {
			return err
		}
	}
	if !writeMarker {
		return nil
	}
	return writePrivateRuntimeFile(marker, []byte(generation))
}

func claudeCredentialUsable(content []byte) bool {
	var credential struct {
		ClaudeAiOauth struct {
			AccessToken string `json:"accessToken"`
			ExpiresAt   int64  `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	return json.Unmarshal(content, &credential) == nil && credential.ClaudeAiOauth.AccessToken != "" && credential.ClaudeAiOauth.ExpiresAt > time.Now().UnixMilli()
}

func claudeCredentialExpiry(content []byte) int64 {
	var credential struct {
		ClaudeAiOauth struct {
			ExpiresAt int64 `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if json.Unmarshal(content, &credential) != nil {
		return 0
	}
	return credential.ClaudeAiOauth.ExpiresAt
}

func explicitClaudeAuthEnvironment(environment map[string]string) bool {
	for _, name := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"} {
		if environment[name] != "" {
			return true
		}
	}
	return false
}

func ClaudeProbeEnvironment(environment map[string]string) (map[string]string, func(), error) {
	prepared := make(map[string]string, len(environment)+1)
	for name, value := range environment {
		prepared[name] = value
	}
	root, err := os.MkdirTemp("", "linger-claude-probe-")
	if err != nil {
		return nil, nil, err
	}
	configRoot := filepath.Join(root, ".claude")
	release := func() { _ = claudeKeychainRemove(configRoot); _ = os.RemoveAll(root) }
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		release()
		return nil, nil, err
	}
	if err := configureClaudeCredentials(configRoot, prepared, nil); err != nil {
		release()
		return nil, nil, err
	}
	return prepared, release, nil
}

// claudeModelInvokeMu serializes credential reconciliation on the shared
// model invocation configuration root.
var claudeModelInvokeMu sync.Mutex

// ClaudeModelInvokeEnvironment points a model call at configRoot, a
// Daemon-owned Claude configuration root that outlives the call. Claude writes
// a refreshed OAuth login into its own configuration root, so a temporary root
// would discard a rotated refresh token and every later call would refresh
// from the stale Host login again. Like a Context Runtime home, the root keeps
// its newer native refresh until the Host login itself changes; the Host login
// is never written.
func ClaudeModelInvokeEnvironment(configRoot string, environment map[string]string) (map[string]string, error) {
	if !filepath.IsAbs(configRoot) {
		return nil, errors.New("Claude model invocation configuration root must be absolute")
	}
	prepared := make(map[string]string, len(environment)+1)
	for name, value := range environment {
		prepared[name] = value
	}
	claudeModelInvokeMu.Lock()
	defer claudeModelInvokeMu.Unlock()
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(configRoot)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Claude configuration must be a managed directory")
	}
	if err := configureClaudeCredentials(configRoot, prepared, nil); err != nil {
		return nil, err
	}
	return prepared, nil
}
