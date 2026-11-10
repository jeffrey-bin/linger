package native

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

const (
	codexConfigName  = "config.toml"
	codexConfigLimit = 32 << 20
)

var (
	codexServerNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	errCodexMissingHome    = errors.New("codex: CODEX_HOME env var is not configured; cannot apply the managed MCP set")
)

// codexProjectMCP writes the managed MCP set into <home>/config.toml,
// replacing the mcp_servers namespace and keeping every other key. All file
// access stays inside home.
func codexProjectMCP(home string, raw json.RawMessage) error {
	raw = mcpNamespace(raw)
	if strings.TrimSpace(home) == "" {
		return errCodexMissingHome
	}
	servers, err := codexProjectedServers(raw)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		return fmt.Errorf("open Codex home: %w", err)
	}
	defer root.Close()
	data, err := codexReadConfig(root)
	if err != nil {
		return err
	}
	config := map[string]any{}
	if len(data) > 0 {
		if err := toml.Unmarshal(data, &config); err != nil {
			return fmt.Errorf("decode Codex configuration: %w", err)
		}
	}
	codexDropMCPServers(config)
	config["mcp_servers"] = servers
	encoded, err := toml.Marshal(config)
	if err != nil {
		return fmt.Errorf("encode Codex configuration: %w", err)
	}
	return codexReplaceConfig(root, encoded)
}

// codexReadConfig returns config.toml, or nothing when it does not exist.
// A symlink or other non-regular file is refused.
func codexReadConfig(root *os.Root) ([]byte, error) {
	info, err := root.Lstat(codexConfigName)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspect Codex configuration: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("Codex configuration must be a bounded regular file")
	}
	if info.Size() > codexConfigLimit {
		return nil, errors.New("Codex configuration is too large")
	}
	file, err := root.Open(codexConfigName)
	if err != nil {
		return nil, fmt.Errorf("read Codex configuration: %w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, codexConfigLimit+1))
	if err != nil {
		return nil, fmt.Errorf("read Codex configuration: %w", err)
	}
	if len(data) > codexConfigLimit {
		return nil, errors.New("Codex configuration is too large")
	}
	return data, nil
}

func codexReplaceConfig(root *os.Root, data []byte) (err error) {
	suffix, err := freshToken(12)
	if err != nil {
		return err
	}
	name := ".mcp-" + suffix
	file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("write Codex configuration: %w", err)
	}
	defer func() {
		if err != nil {
			_ = root.Remove(name)
		}
	}()
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write Codex configuration: %w", err)
	}
	if err = root.Rename(name, codexConfigName); err != nil {
		return fmt.Errorf("replace Codex configuration: %w", err)
	}
	return nil
}

// codexDropMCPServers removes mcp_servers at the top level and from every
// profile table.
func codexDropMCPServers(config map[string]any) {
	delete(config, "mcp_servers")
	if profiles, ok := config["profiles"].(map[string]any); ok {
		for _, profile := range profiles {
			if table, ok := profile.(map[string]any); ok {
				delete(table, "mcp_servers")
			}
		}
	}
}

// codexProjectedServers maps {"mcpServers":{...}} to Codex's mcp_servers
// table.
func codexProjectedServers(raw json.RawMessage) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var document any
	if err := decoder.Decode(&document); err != nil {
		return nil, errors.New("MCP configuration must be an object")
	}
	top, ok := document.(map[string]any)
	if !ok {
		return nil, errors.New("MCP configuration must be an object")
	}
	projected := map[string]any{}
	rawServers, present := top["mcpServers"]
	if !present {
		return projected, nil
	}
	servers, ok := rawServers.(map[string]any)
	if !ok {
		return nil, errors.New("mcpServers must be an object")
	}
	for name, value := range servers {
		server, ok := value.(map[string]any)
		if name == "" || !ok {
			return nil, errors.New("MCP server requires a name and object configuration")
		}
		if !codexServerNamePattern.MatchString(name) {
			return nil, errors.New("MCP server name is not supported by Codex")
		}
		projected[name] = codexProjectServer(server)
	}
	return projected, nil
}

func codexProjectServer(server map[string]any) map[string]any {
	out := make(map[string]any, len(server))
	for key, value := range server {
		switch key {
		case "tools", "prompts", "resources":
			continue
		}
		out[key] = codexTOMLValue(value)
	}
	kind, _ := server["type"].(string)
	_, hasURL := server["url"]
	_, hasCommand := server["command"]
	if strings.EqualFold(kind, "http") || (hasURL && !hasCommand) {
		delete(out, "type")
		if headers, ok := out["headers"]; ok {
			if _, exists := out["http_headers"]; !exists {
				out["http_headers"] = headers
			}
			delete(out, "headers")
		}
		out["experimental_use_rmcp_client"] = true
	}
	return out
}

// codexTOMLValue turns decoded JSON numbers into TOML integers or floats and
// drops nulls, which TOML cannot express.
func codexTOMLValue(value any) any {
	switch typed := value.(type) {
	case json.Number:
		if integer, err := typed.Int64(); err == nil {
			return integer
		}
		float, _ := typed.Float64()
		return float
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			if item != nil {
				out[key] = codexTOMLValue(item)
			}
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			if item != nil {
				out = append(out, codexTOMLValue(item))
			}
		}
		return out
	}
	return value
}

// codexMCPHash identifies the MCP config a process was given.
func codexMCPHash(raw json.RawMessage) string {
	sum := sha256.Sum256(bytes.TrimSpace(mcpNamespace(raw)))
	return hex.EncodeToString(sum[:])
}

// codexBindingFingerprint certifies that a loaded thread was bound under
// the same inputs: the declared ones and the digest of the configuration
// the Daemon projected. A file Codex writes into its home later is not an
// input. Empty means "never reuse".
func codexBindingFingerprint(home, configDigest string, spec RunSpec) string {
	if strings.TrimSpace(home) == "" {
		return ""
	}
	hash := sha256.New()
	field := func(value string) {
		_, _ = fmt.Fprintf(hash, "%d:%s\n", len(value), value)
	}
	optional := func(value *string) {
		if value == nil {
			field("nil")
			return
		}
		field("set")
		field(*value)
	}
	field(spec.Dir)
	field(spec.Model)
	field(spec.Effort)
	field(fmt.Sprint(toolOutputTokenLimit(spec.ContextWindow)))
	optional(spec.BaseInstructions)
	optional(codexDeveloperInstructions(spec))
	field(spec.Title)
	field(fmt.Sprint(spec.CodexPermissionHook != nil))
	field(configDigest)
	return hex.EncodeToString(hash.Sum(nil))
}

// codexDeveloperInstructions is the effective developerInstructions value.
func codexDeveloperInstructions(spec RunSpec) *string {
	if spec.BaseInstructions != nil || spec.DeveloperInstructions != nil {
		return spec.DeveloperInstructions
	}
	if spec.AppendPrompt != "" {
		value := spec.AppendPrompt
		return &value
	}
	return nil
}
