package native

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const piMCPConfigEnvKey = "LINGER_PI_MANAGED_MCP_CONFIG"

// piMCPWiring is the managed MCP set prepared for one Pi process. A zero
// value wires nothing.
type piMCPWiring struct {
	extension  string
	configPath string
}

func (w piMCPWiring) wired() bool { return w.configPath != "" }

// piPrepareMCP writes the caller's MCP bytes unchanged next to the session
// and names the managed extension that loads them. Pi never falls back to
// an ambient MCP configuration.
func piPrepareMCP(raw json.RawMessage, extension, sessionDir string) (piMCPWiring, error) {
	raw = mcpNamespace(raw)
	var config struct {
		MCPServers *map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return piMCPWiring{}, fmt.Errorf("invalid managed Pi MCP configuration: %w", err)
	}
	if config.MCPServers == nil || len(*config.MCPServers) == 0 {
		return piMCPWiring{}, nil
	}
	if extension == "" || !filepath.IsAbs(extension) {
		return piMCPWiring{}, errors.New("the managed Pi MCP extension is not installed; repair the Computer installation")
	}
	info, err := os.Stat(extension)
	if err != nil || !info.Mode().IsRegular() {
		return piMCPWiring{}, errors.New("the managed Pi MCP extension is unavailable; repair the Computer installation")
	}
	path := filepath.Join(sessionDir, piMCPConfigName)
	if err := piWritePrivate(path, raw); err != nil {
		return piMCPWiring{}, fmt.Errorf("managed Pi MCP configuration could not be written: %w", err)
	}
	return piMCPWiring{extension: extension, configPath: path}, nil
}

func (w piMCPWiring) remove() {
	if w.configPath != "" {
		_ = os.Remove(w.configPath)
	}
}
