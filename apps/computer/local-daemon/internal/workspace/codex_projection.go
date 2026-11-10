package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// The caller resolves the user identity and holds the Runtime home lease.
// No process environment is consulted to choose a source home.
type CodexHomeOptions struct {
	SharedHome, UserHome, CodexVersion string
	CodexCustomArgs                    []string
	// ModelsCache names the homes a models cache is seeded from; nil seeds
	// nothing.
	ModelsCache *CodexModelsCachePeers
}

const projectionState = ".linger-projection.json"
const projectionAssets = ".linger-config"

type projectionRecord struct {
	Configuration string   `json:"configuration"`
	Assets        []string `json:"assets"`
}

// CodexProjection is what PrepareCodexHome delivered to a Codex home.
type CodexProjection struct {
	// Args are the Codex `-c` overrides the Daemon owns for the home.
	Args []string
	// ConfigDigest identifies the configuration files the Daemon wrote. The
	// MCP servers are left out: every Operation brings its own set.
	ConfigDigest string
	// SkillDigest identifies the Skills the Daemon linked and the disable
	// rules it wrote. Skills Codex installs itself are not part of it.
	SkillDigest string
}

// PrepareCodexHome snapshots configuration, then publishes private files through
// an opened directory handle. Session state is never read from the source home.
func PrepareCodexHome(home string, opts CodexHomeOptions, logger *slog.Logger) (CodexProjection, error) {
	if !filepath.IsAbs(home) || !filepath.IsAbs(opts.SharedHome) || filepath.Clean(home) == filepath.Clean(opts.SharedHome) {
		return CodexProjection{}, errors.New("Codex projection requires distinct absolute source and Runtime homes")
	}
	config, err := readProjectionSource(filepath.Join(opts.SharedHome, "config.toml"))
	if err != nil {
		return CodexProjection{}, err
	}
	settings := make(map[string]any)
	if len(config) != 0 {
		if err := toml.Unmarshal(config, &settings); err != nil {
			return CodexProjection{}, fmt.Errorf("parse Codex configuration: %w", err)
		}
	}
	// A reviewed Run trusts hooks by request, so a copied user hook would run
	// untrusted beside the Daemon's own and could allow a call the review never
	// saw.
	delete(settings, "hooks")
	if profiles, ok := settings["profiles"].(map[string]any); ok {
		for _, value := range profiles {
			if profile, ok := value.(map[string]any); ok {
				delete(profile, "hooks")
			}
		}
	}
	// Trusted Host Access launches Codex unsandboxed on every platform. A
	// Windows elevated sandbox would run shell commands as a separate account
	// that cannot read the TeamHub CLI or the Agent credential.
	args := []string{"-c", `sandbox_mode="danger-full-access"`}
	files := make(map[string][]byte)
	references := make(map[string][]byte)
	for _, name := range []string{"config.json", "instructions.md", "AGENTS.md", "AGENTS.override.md"} {
		data, err := readProjectionSource(filepath.Join(opts.SharedHome, name))
		if err != nil {
			return CodexProjection{}, err
		}
		files[name] = data
	}
	// Parse and serialize the tree once. Desktop Skill entries are regenerated
	// from discovered paths.
	if table, ok := settings["skills"].(map[string]any); ok {
		delete(table, "config")
	}
	if err := collectConfigAssets(settings, home, opts, files, references, "root"); err != nil {
		return CodexProjection{}, err
	}
	if profiles, ok := settings["profiles"].(map[string]any); ok {
		for name, value := range profiles {
			if profile, ok := value.(map[string]any); ok {
				if err := collectConfigAssets(profile, home, opts, files, references, "profile:"+name); err != nil {
					return CodexProjection{}, err
				}
			}
		}
	}
	projected, err := toml.Marshal(settings)
	if err != nil {
		return CodexProjection{}, err
	}
	// Always publish config.toml, even when empty; a nil entry means removal.
	files["config.toml"] = append([]byte{}, projected...)
	configDigest, err := codexConfigDigest(settings, files, references)
	if err != nil {
		return CodexProjection{}, err
	}
	// Bind to the source configuration as well as projected referenced bytes.
	// Shared caches have no reliable provider binding and are never imported.
	encoded, err := json.Marshal(struct {
		Source     []byte
		Files      map[string][]byte
		References map[string][]byte
	}{config, files, references})
	if err != nil {
		return CodexProjection{}, err
	}
	sum := sha256.Sum256(encoded)
	record := projectionRecord{Configuration: hex.EncodeToString(sum[:])}
	for name := range files {
		if strings.HasPrefix(name, projectionAssets+string(filepath.Separator)) {
			record.Assets = append(record.Assets, name)
		}
	}
	slices.Sort(record.Assets)

	root, err := openProjectionRoot(home)
	if err != nil {
		return CodexProjection{}, err
	}
	defer root.Close()
	if source, err := os.Stat(opts.SharedHome); err == nil {
		target, err := root.Stat(".")
		if err != nil {
			return CodexProjection{}, err
		}
		if os.SameFile(source, target) {
			return CodexProjection{}, errors.New("Codex source resolves to the Runtime home")
		}
	}
	for _, name := range []string{"sessions", projectionAssets} {
		if err := localProjectionDirectory(root, name); err != nil {
			return CodexProjection{}, err
		}
	}
	var previous projectionRecord
	previousBytes, readErr := root.ReadFile(projectionState)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return CodexProjection{}, readErr
	}
	if len(previousBytes) > 0 && json.Unmarshal(previousBytes, &previous) != nil {
		return CodexProjection{}, errors.New("invalid Codex projection record")
	}
	if previous.Configuration != record.Configuration {
		if err := removeProjectionFile(root, "models_cache.json"); err != nil {
			return CodexProjection{}, err
		}
	}
	// Retire the old daemon cache binding. It is not an alternative read format.
	if err := removeProjectionFile(root, ".models_cache_config.sha256"); err != nil {
		return CodexProjection{}, err
	}
	for _, name := range previous.Assets {
		if !filepath.IsLocal(name) || filepath.Dir(name) != projectionAssets {
			return CodexProjection{}, errors.New("invalid Codex projection asset")
		}
		if !slices.Contains(record.Assets, name) {
			if err := removeProjectionFile(root, name); err != nil {
				return CodexProjection{}, err
			}
		}
	}
	for name, data := range files {
		if data == nil {
			if err := removeProjectionFile(root, name); err != nil {
				return CodexProjection{}, err
			}
		} else if err := replaceProjectionFile(root, name, data); err != nil {
			return CodexProjection{}, err
		}
	}
	if codexAuthRequired(settings, opts.CodexCustomArgs) {
		if err := projectAuthentication(root, opts.SharedHome); err != nil {
			return CodexProjection{}, err
		}
	} else {
		if logger != nil {
			logger.Info("Codex auth projection skipped", "model_provider", settings["model_provider"])
		}
		if err := removeProjectionFile(root, "auth.json"); err != nil {
			return CodexProjection{}, err
		}
	}
	userHome := opts.UserHome
	if userHome == "" {
		userHome = filepath.Dir(opts.SharedHome)
	}
	if err := localProjectionDirectory(root, "skills"); err != nil {
		return CodexProjection{}, err
	}
	skillDigest, err := syncCodexSkills(home, opts.SharedHome, userHome)
	if err != nil {
		if logger != nil {
			logger.Warn("Codex Skill projection unavailable", "error", err)
		}
		// Skills that could not be projected stay unprojected the same way for
		// every Operation until the source is fixed, so the identity does too.
		skillDigest = "unavailable"
	}
	// Plugins reference installed files through their cache. Do not create or
	// mutate anything in the user's source home when the cache is absent.
	if err := localProjectionDirectory(root, "plugins"); err != nil {
		return CodexProjection{}, err
	}
	if err := ensureSymlink(filepath.Join(opts.SharedHome, "plugins", "cache"), filepath.Join(home, "plugins", "cache")); err != nil {
		return CodexProjection{}, err
	}
	encoded, err = json.Marshal(record)
	if err != nil {
		return CodexProjection{}, err
	}
	if err := replaceProjectionFile(root, projectionState, encoded); err != nil {
		return CodexProjection{}, err
	}
	if opts.ModelsCache != nil {
		seedCodexModelsCache(root, home, opts.SharedHome, opts.CodexVersion, *opts.ModelsCache, logger)
	}
	return CodexProjection{Args: args, ConfigDigest: configDigest, SkillDigest: skillDigest}, nil
}

// codexConfigDigest identifies the projected configuration without the MCP
// servers, at the root or in a profile, which the Daemon replaces for every
// Operation.
func codexConfigDigest(settings map[string]any, files, references map[string][]byte) (string, error) {
	withoutMCP := make(map[string]any, len(settings))
	for key, value := range settings {
		switch key {
		case "mcp_servers":
		case "profiles":
			profiles, _ := value.(map[string]any)
			trimmed := make(map[string]any, len(profiles))
			for name, raw := range profiles {
				profile, ok := raw.(map[string]any)
				if !ok {
					trimmed[name] = raw
					continue
				}
				copied := make(map[string]any, len(profile))
				for field, setting := range profile {
					if field != "mcp_servers" {
						copied[field] = setting
					}
				}
				trimmed[name] = copied
			}
			withoutMCP[key] = trimmed
		default:
			withoutMCP[key] = value
		}
	}
	config, err := toml.Marshal(withoutMCP)
	if err != nil {
		return "", err
	}
	projected := make(map[string][]byte, len(files))
	for name, data := range files {
		projected[name] = data
	}
	projected["config.toml"] = config
	encoded, err := json.Marshal(struct {
		Files      map[string][]byte
		References map[string][]byte
	}{projected, references})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func collectConfigAssets(table map[string]any, home string, opts CodexHomeOptions, files map[string][]byte, references map[string][]byte, scope string) error {
	for _, key := range []string{"model_catalog_json", "model_instructions_file", "experimental_instructions_file"} {
		value, exists := table[key]
		if !exists {
			continue
		}
		path, ok := value.(string)
		if !ok {
			return fmt.Errorf("Codex %s must be a path string", key)
		}
		if path == "" {
			continue
		}
		source := path
		switch {
		case strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`):
			user := opts.UserHome
			if user == "" {
				user = filepath.Dir(opts.SharedHome)
			}
			source = filepath.Join(user, path[2:])
		case filepath.IsAbs(path):
		case filepath.IsLocal(path):
			source = filepath.Join(opts.SharedHome, path)
		default:
			return fmt.Errorf("Codex %s cannot traverse outside its source home", key)
		}
		data, err := readProjectionSource(source)
		if err != nil {
			return err
		}
		if data == nil {
			return fmt.Errorf("Codex %s references a missing file", key)
		}
		references[scope+"/"+key] = data
		if filepath.IsAbs(path) || strings.HasPrefix(path, "~") {
			continue
		}
		digest := sha256.Sum256([]byte(scope + "\x00" + key))
		name := filepath.Join(projectionAssets, hex.EncodeToString(digest[:12]))
		files[name] = data
		table[key] = filepath.Join(home, name)
	}
	return nil
}

func readProjectionSource(path string) ([]byte, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read Codex projection source %s: %w", filepath.Base(path), err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	const limit = 32 << 20
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("Codex projection source must be a regular file of at most 32 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, errors.New("Codex projection source exceeds 32 MiB")
	}
	return data, nil
}

func openProjectionRoot(path string) (*os.Root, error) {
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	opened, e1 := root.Stat(".")
	named, e2 := os.Lstat(path)
	if e1 != nil || e2 != nil || !named.IsDir() || !os.SameFile(opened, named) {
		_ = root.Close()
		return nil, errors.New("Runtime home must remain the same real directory")
	}
	return root, nil
}

func localProjectionDirectory(root *os.Root, path string) error {
	if err := root.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := root.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("Runtime home %s must be a real directory", path)
	}
	return nil
}

func removeProjectionFile(root *os.Root, name string) error {
	err := root.Remove(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func replaceProjectionFile(root *os.Root, name string, data []byte) error {
	if !filepath.IsLocal(name) {
		return errors.New("invalid projection destination")
	}
	// The root lease serializes publishers. Remove a stale temporary entry
	// without following it, then create a new inode with exclusive access.
	temporary := name + ".pending"
	if err := removeProjectionFile(root, temporary); err != nil {
		return err
	}
	out, err := root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)
	_, writeErr := out.Write(data)
	closeErr := out.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	// Rename replaces destination links themselves instead of their targets.
	return root.Rename(temporary, name)
}

// Custom providers that do not request OpenAI auth must not receive the user's
// ChatGPT token: an expired token makes app-server refresh it before initialize.
// Any profile or provider override in launch args may switch providers, so it
// keeps authentication projected.
func codexAuthRequired(settings map[string]any, customArgs []string) bool {
	provider, ok := settings["model_provider"].(string)
	if !ok || provider == "" || provider == "openai" {
		return true
	}
	if _, ok := settings["profile"]; ok {
		return true
	}
	for _, arg := range customArgs {
		if strings.Contains(arg, "model_provider") || strings.Contains(arg, "profile") || arg == "-p" {
			return true
		}
	}
	providers, ok := settings["model_providers"].(map[string]any)
	if !ok {
		return true
	}
	entry, ok := providers[provider].(map[string]any)
	if !ok {
		return true
	}
	if value, exists := entry["requires_openai_auth"]; exists && value != false {
		return true
	}
	return false
}

func projectAuthentication(root *os.Root, source string) error {
	path := filepath.Join(source, "auth.json")
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return removeProjectionFile(root, "auth.json")
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("Codex authentication source is not a regular file")
	}
	if err := removeProjectionFile(root, "auth.json"); err != nil {
		return err
	}
	if err := root.Symlink(path, "auth.json"); err == nil {
		return nil
	} else if runtime.GOOS != "windows" {
		return err
	}
	data, err := readProjectionSource(path)
	if err != nil {
		return err
	}
	if data == nil {
		return errors.New("Codex authentication source disappeared")
	}
	return replaceProjectionFile(root, "auth.json", data)
}
