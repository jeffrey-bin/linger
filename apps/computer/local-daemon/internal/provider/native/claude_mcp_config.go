package native

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const (
	claudeMCPDirPrefix = "linger-mcp-"
	claudeMCPFileName  = "mcp-config.json"
)

// claudeWriteMCPConfig writes a managed MCP configuration into a fresh
// private temp directory and returns the file path.
func claudeWriteMCPConfig(config []byte) (string, error) {
	dir, err := os.MkdirTemp("", claudeMCPDirPrefix)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, claudeMCPFileName)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, err = file.Write(config)
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
	}
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	return path, nil
}

// claudeRemoveMCPConfig removes the directory claudeWriteMCPConfig made, or
// only the file when the path does not have that layout.
func claudeRemoveMCPConfig(path string) {
	if path == "" {
		return
	}
	dir := filepath.Dir(path)
	if filepath.Base(path) == claudeMCPFileName && strings.HasPrefix(filepath.Base(dir), claudeMCPDirPrefix) {
		_ = os.RemoveAll(dir)
		return
	}
	_ = os.Remove(path)
}

// claudeToolTimeouts gives each server that sets Codex's tool_timeout_sec
// the same limit in Claude's own timeout key, in milliseconds. Without it
// Claude ends an HTTP MCP call after 60 seconds, shorter than a local
// computer call may take.
func claudeToolTimeouts(config json.RawMessage) json.RawMessage {
	document, servers, ok := decodeMCPDocument(config)
	if !ok {
		return config
	}
	changed := false
	for _, value := range servers {
		server, ok := value.(map[string]any)
		if !ok || server["timeout"] != nil {
			continue
		}
		seconds, ok := server["tool_timeout_sec"].(json.Number)
		if !ok {
			continue
		}
		if limit, err := seconds.Float64(); err == nil && limit > 0 {
			server["timeout"] = int64(limit * 1000)
			changed = true
		}
	}
	if !changed {
		return config
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return config
	}
	return encoded
}
