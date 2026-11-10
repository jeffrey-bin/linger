package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/pelletier/go-toml/v2"
)

// codexInvokeConfigKeys are the only config.toml keys a one-shot model call
// keeps: the ones that choose the model, the provider and how it signs in.
// Instructions, MCP servers, hooks, Skills, plugins, sandbox and approval
// settings never reach it, so a background call sees none of the user's
// customizations.
var codexInvokeConfigKeys = []string{
	"model",
	"model_provider",
	"model_providers",
	"profile",
	"profiles",
	"cli_auth_credentials_store",
	"forced_login_method",
	"forced_chatgpt_workspace_id",
	"chatgpt_base_url",
	"openai_base_url",
}

// codexInvokeProfileKeys are the keys kept inside each named profile.
var codexInvokeProfileKeys = []string{"model", "model_provider"}

// CodexInvokeHome describes a minimal CODEX_HOME prepared for one model call.
type CodexInvokeHome struct {
	// Model is the configured default model, empty when the CLI picks one.
	Model string
	// AuthenticationMissing reports that the provider needs the user's OpenAI
	// sign-in and the source home has no auth.json.
	AuthenticationMissing bool
}

// PrepareCodexInvokeHome writes a minimal Codex home into home: a config.toml
// holding only provider-selecting keys, auth.json linked to the source so a
// token refresh writes back to the user's file, and a models cache seeded from
// the source home and modelsCache so the call does not wait on a catalog fetch.
func PrepareCodexInvokeHome(home, sourceHome, codexVersion string, modelsCache CodexModelsCachePeers) (CodexInvokeHome, error) {
	if !filepath.IsAbs(home) || !filepath.IsAbs(sourceHome) || filepath.Clean(home) == filepath.Clean(sourceHome) {
		return CodexInvokeHome{}, errors.New("Codex invocation home requires distinct absolute source and target homes")
	}
	config, err := readProjectionSource(filepath.Join(sourceHome, "config.toml"))
	if err != nil {
		return CodexInvokeHome{}, err
	}
	settings := make(map[string]any)
	if len(config) != 0 {
		if err := toml.Unmarshal(config, &settings); err != nil {
			return CodexInvokeHome{}, fmt.Errorf("parse Codex configuration: %w", err)
		}
	}
	kept := pickKeys(settings, codexInvokeConfigKeys)
	if profiles, ok := kept["profiles"].(map[string]any); ok {
		minimal := make(map[string]any, len(profiles))
		for name, value := range profiles {
			if profile, ok := value.(map[string]any); ok {
				minimal[name] = pickKeys(profile, codexInvokeProfileKeys)
			}
		}
		kept["profiles"] = minimal
	}
	projected, err := toml.Marshal(kept)
	if err != nil {
		return CodexInvokeHome{}, err
	}
	root, err := openProjectionRoot(home)
	if err != nil {
		return CodexInvokeHome{}, err
	}
	defer root.Close()
	if err := replaceProjectionFile(root, "config.toml", projected); err != nil {
		return CodexInvokeHome{}, err
	}
	if err := projectAuthentication(root, sourceHome); err != nil {
		return CodexInvokeHome{}, err
	}
	seedCodexModelsCache(root, home, sourceHome, codexVersion, modelsCache, nil)
	result := CodexInvokeHome{}
	if model, ok := kept["model"].(string); ok {
		result.Model = model
	}
	if codexAuthRequired(kept, nil) {
		if _, err := root.Lstat("auth.json"); errors.Is(err, os.ErrNotExist) {
			result.AuthenticationMissing = true
		}
	}
	return result, nil
}

func pickKeys(source map[string]any, keys []string) map[string]any {
	result := make(map[string]any, len(keys))
	for _, key := range keys {
		if value, ok := source[key]; ok {
			result[key] = value
		}
	}
	return result
}
