package mcpproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

var ErrCleanupUnconfirmed = errors.New("local tool cleanup is unconfirmed")

// LocalBinding is installed by the trusted daemon composition, never decoded
// from a remote Relay descriptor. It retains native MCP image content and its
// own downstream cleanup receipt instead of treating HTTP close as proof.
type LocalBinding struct {
	Name      string
	URL       string
	ToolNames []string
	WaitReady func(context.Context) error
	Close     func() error
	// Evidence describes the target of one of the binding's tool calls for
	// the permission review, or returns nil.
	Evidence func(ctx context.Context, tool string, input json.RawMessage) *permission.Evidence
	// Allowed reports whether one of the binding's tool calls follows from
	// what the Agent has already seen and runs without review.
	Allowed func(tool string, input json.RawMessage) bool
}

func (s *Set) AddLocal(binding LocalBinding) error {
	if s == nil || binding.Name == "" || binding.URL == "" || binding.Close == nil || binding.WaitReady == nil {
		return errors.New("incomplete local MCP binding")
	}
	var config struct {
		Servers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(s.config, &config); err != nil {
		return err
	}
	if config.Servers == nil {
		config.Servers = map[string]json.RawMessage{}
	}
	if _, exists := config.Servers[binding.Name]; exists {
		return fmt.Errorf("MCP name is duplicated: %s", binding.Name)
	}
	server, err := json.Marshal(map[string]any{"type": "http", "url": binding.URL, "tool_timeout_sec": 180})
	if err != nil {
		return err
	}
	config.Servers[binding.Name] = server
	encoded, err := json.Marshal(config)
	if err != nil {
		return err
	}
	s.config = encoded
	s.local = append(s.local, binding)
	return nil
}

func (s *Set) LocalToolNames() []string {
	if s == nil {
		return nil
	}
	var names []string
	for _, binding := range s.local {
		for _, name := range binding.ToolNames {
			names = append(names, "mcp__"+binding.Name+"__"+name)
		}
	}
	return names
}

// LocalAllowed reports whether a call of one of the local tools, named as the
// Runtime names it, runs without review.
func (s *Set) LocalAllowed(tool, input string) bool {
	if s == nil {
		return false
	}
	server, name, ok := strings.Cut(strings.TrimPrefix(tool, "mcp__"), "__")
	if !ok {
		return false
	}
	for _, binding := range s.local {
		if binding.Name == server && binding.Allowed != nil {
			return binding.Allowed(name, json.RawMessage(input))
		}
	}
	return false
}

// LocalEvidence collects the permission review evidence for a call of one of
// the local tools, named as the Runtime names it (mcp__<server>__<tool>).
func (s *Set) LocalEvidence(ctx context.Context, tool, input string) *permission.Evidence {
	if s == nil {
		return nil
	}
	server, name, ok := strings.Cut(strings.TrimPrefix(tool, "mcp__"), "__")
	if !ok {
		return nil
	}
	for _, binding := range s.local {
		if binding.Name == server && binding.Evidence != nil {
			return binding.Evidence(ctx, name, json.RawMessage(input))
		}
	}
	return nil
}
