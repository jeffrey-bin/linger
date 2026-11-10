package native

import (
	"context"
	"fmt"
	"strings"
)

type ModelList struct {
	Models []ModelOption `json:"models"`
}

// ModelOption is one selectable model. Default marks the CLI's own default
// when known; display fields never choose a model for execution.
type ModelOption struct {
	ID       string         `json:"id"`
	Label    string         `json:"label"`
	Provider string         `json:"provider"`
	Default  bool           `json:"default,omitempty"`
	Effort   *EffortSupport `json:"effort,omitempty"`
	// ContextWindow is the context length in tokens the Runtime itself
	// declares for the model; zero when it does not say.
	ContextWindow int `json:"context_window,omitempty"`
	// Resolved is the concrete model an alias runs; empty when ID is one.
	Resolved string `json:"-"`
}

type EffortSupport struct {
	Options []EffortOption `json:"options"`
	Default string         `json:"default,omitempty"`
}

type EffortOption struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

const catalogTokenLimit = 160

// DiscoverModels lists the models a Runtime CLI offers, by kind.
func DiscoverModels(ctx context.Context, kind string, inv Invocation) (ModelList, error) {
	switch kind {
	case "claude":
		return claudeCatalog(ctx, inv)
	case "codex":
		return codexCatalog(ctx, inv)
	case "pi":
		return DiscoverPiModels(ctx, inv)
	}
	return ModelList{}, fmt.Errorf("model discovery is unsupported for Runtime %q", kind)
}

// validCatalogToken accepts a model id or effort value: non-empty, at most
// 160 bytes, no space, control character or DEL.
func validCatalogToken(token string) bool {
	if token == "" || len(token) > catalogTokenLimit {
		return false
	}
	for i := 0; i < len(token); i++ {
		if token[i] <= ' ' || token[i] == 0x7f {
			return false
		}
	}
	return true
}

func effortLabel(value string) string {
	switch value {
	case "xhigh":
		return "Extra high"
	case "off", "none", "minimal", "low", "medium", "high", "max", "ultra":
		return strings.ToUpper(value[:1]) + value[1:]
	}
	return value
}

// catalogModels accumulates models with first-seen deduplication of ids.
type catalogModels struct {
	seen   map[string]bool
	models []ModelOption
}

// add keeps a model with a valid, unseen id. An empty label falls back to
// the id.
func (c *catalogModels) add(model ModelOption) bool {
	if !validCatalogToken(model.ID) || c.seen[model.ID] {
		return false
	}
	if c.seen == nil {
		c.seen = map[string]bool{}
	}
	c.seen[model.ID] = true
	if model.Label == "" {
		model.Label = model.ID
	}
	c.models = append(c.models, model)
	return true
}

func (c *catalogModels) list() ModelList { return ModelList{Models: c.models} }

// effortCatalog accumulates effort options with first-seen deduplication.
type effortCatalog struct {
	options []EffortOption
}

func (e *effortCatalog) add(value, description string) {
	if !validCatalogToken(value) {
		return
	}
	for _, option := range e.options {
		if option.Value == value {
			return
		}
	}
	e.options = append(e.options, EffortOption{Value: value, Label: effortLabel(value), Description: description})
}

// support returns nil without options; the default is kept only when it is
// one of the advertised options.
func (e *effortCatalog) support(defaultValue string) *EffortSupport {
	if len(e.options) == 0 {
		return nil
	}
	out := &EffortSupport{Options: e.options}
	for _, option := range e.options {
		if option.Value == defaultValue {
			out.Default = defaultValue
		}
	}
	return out
}
