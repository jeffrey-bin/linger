package lingercontext

import (
	"context"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type ProviderCatalog struct {
	mu     sync.RWMutex
	values map[string]ProviderInstallation
}

func NewProviderCatalog(values map[string]ProviderInstallation) *ProviderCatalog {
	catalog := &ProviderCatalog{}
	catalog.Replace(values)
	return catalog
}

func (c *ProviderCatalog) Replace(values map[string]ProviderInstallation) {
	next := make(map[string]ProviderInstallation, len(values))
	for key, value := range values {
		value.Environment = cloneEnvironment(value.Environment)
		next[key] = value
	}
	c.mu.Lock()
	c.values = next
	c.mu.Unlock()
}

func (c *ProviderCatalog) Lookup(_ context.Context, runtimeType string) (ProviderInstallation, bool, error) {
	c.mu.RLock()
	value, ok := c.values[runtimeType]
	c.mu.RUnlock()
	if ok && value.EntryPath != "" {
		if err := provider.ValidateRuntimeExecutable(value.EntryPath, value.ExecutablePath); err != nil {
			return ProviderInstallation{}, false, err
		}
	}
	value.Environment = cloneEnvironment(value.Environment)
	return value, ok, nil
}
