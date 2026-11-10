package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"

	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// Context length lookup bounds. The lookup runs during discovery, off every
// user-facing path, and a failure only leaves a context length unknown.
const (
	gatewayModelsTimeout  = 5 * time.Second
	gatewayModelsMaxBytes = 4 << 20
	runtimeConfigMaxBytes = 4 << 20
	maxModelContextWindow = 100_000_000
)

// gatewayEndpoint is the base URL a Runtime's API link lists models under,
// and the key it signs in with there.
type gatewayEndpoint struct {
	baseURL string
	token   string
	// apiKey is sent as x-api-key with an Anthropic API version, the way
	// Claude sends ANTHROPIC_API_KEY.
	apiKey string
}

// anthropicAPIVersion is the Anthropic API version Claude's gateway is asked
// with.
const anthropicAPIVersion = "2023-06-01"

// gatewayModel names one Runtime model at its gateway.
type gatewayModel struct {
	endpoint gatewayEndpoint
	id       string
}

// The links a Runtime reaches a model through, as RuntimeModel.Link reports
// them.
const (
	linkAPI          = "api"
	linkSubscription = "subscription"
)

// modelLink is the link a Runtime reaches one model through and the context
// length the model has there; a zero window is unknown.
type modelLink struct {
	link   string
	window int
}

// newGetModelLink returns getModelLink for one discovery of a Runtime.
//
// A Runtime reaches each model through exactly one link: the API link, a
// gateway and key the user set up in the Runtime's own configuration, or the
// vendor subscription it signed in to. Codex and Claude reach every model
// through the same link; Pi decides per provider. On the API link the
// gateway's model list is authoritative, so getModelLink asks it, once per
// gateway, with that link's key. Otherwise, or when the gateway does not say,
// it returns the context length the Runtime itself declares for the model.
// Subscription credentials are never read.
func newGetModelLink(ctx context.Context, kind string, environment map[string]string) func(RuntimeModel) modelLink {
	apiLink := func(RuntimeModel) (gatewayModel, bool) { return gatewayModel{}, false }
	declared := func(model RuntimeModel) int { return model.ContextWindow }
	switch kind {
	case "codex":
		if endpoint, ok := codexGatewayEndpoint(environment); ok {
			apiLink = func(model RuntimeModel) (gatewayModel, bool) {
				return gatewayModel{endpoint: endpoint, id: model.ID}, true
			}
		}
		catalog, cache := codexCatalogContextLengths(environment), codexModelsCacheContextLengths(environment)
		declared = func(model RuntimeModel) int {
			if window := catalog[model.ID]; window > 0 {
				return window
			}
			return cache[model.ID]
		}
	case "claude":
		if endpoint, ok := claudeGatewayEndpoint(environment); ok {
			apiLink = func(model RuntimeModel) (gatewayModel, bool) {
				return gatewayModel{endpoint: endpoint, id: claudeGatewayModelID(model)}, true
			}
		}
	case "pi":
		providers := piGatewayProviders(environment)
		apiLink = func(model RuntimeModel) (gatewayModel, bool) {
			provider, id, ok := strings.Cut(model.ID, "/")
			endpoint, configured := providers[provider]
			return gatewayModel{endpoint: endpoint, id: id}, ok && configured
		}
	}
	listed := map[gatewayEndpoint]map[string]int{}
	return func(model RuntimeModel) modelLink {
		target, ok := apiLink(model)
		if !ok {
			return modelLink{link: linkSubscription, window: declared(model)}
		}
		windows, fetched := listed[target.endpoint]
		if !fetched {
			windows, _ = gatewayContextWindows(ctx, target.endpoint)
			listed[target.endpoint] = windows
		}
		if window := gatewayWindow(windows, target.id); window > 0 {
			return modelLink{link: linkAPI, window: window}
		}
		return modelLink{link: linkAPI, window: declared(model)}
	}
}

// codexGatewayEndpoint reads the API link from the Codex home the catalog was
// discovered with: the active custom provider. The built-in OpenAI provider
// has no model_providers entry and is the subscription link.
func codexGatewayEndpoint(environment map[string]string) (gatewayEndpoint, bool) {
	home := strings.TrimSpace(environment["CODEX_HOME"])
	if home == "" {
		return gatewayEndpoint{}, false
	}
	data, err := readRuntimeConfig(filepath.Join(home, "config.toml"))
	if err != nil {
		return gatewayEndpoint{}, false
	}
	var config struct {
		ModelProvider string `toml:"model_provider"`
		Profile       string `toml:"profile"`
		Profiles      map[string]struct {
			ModelProvider string `toml:"model_provider"`
		} `toml:"profiles"`
		ModelProviders map[string]struct {
			BaseURL     string `toml:"base_url"`
			EnvKey      string `toml:"env_key"`
			BearerToken string `toml:"experimental_bearer_token"`
		} `toml:"model_providers"`
	}
	if toml.Unmarshal(data, &config) != nil {
		return gatewayEndpoint{}, false
	}
	name := config.ModelProvider
	if profile, ok := config.Profiles[config.Profile]; config.Profile != "" && ok && profile.ModelProvider != "" {
		name = profile.ModelProvider
	}
	provider, ok := config.ModelProviders[name]
	if !ok || strings.TrimSpace(provider.BaseURL) == "" {
		return gatewayEndpoint{}, false
	}
	token := provider.BearerToken
	if token == "" && provider.EnvKey != "" {
		token = environment[provider.EnvKey]
	}
	return gatewayEndpoint{baseURL: provider.BaseURL, token: token}, true
}

// claudeGatewayEndpoint reads Claude's API link: ANTHROPIC_BASE_URL and a key
// for it, from the environment or the user's Claude settings, under which
// Claude calls /v1/messages. A base URL alone still signs in with the
// subscription, and without one Claude talks to Anthropic, whose models it
// knows.
func claudeGatewayEndpoint(environment map[string]string) (gatewayEndpoint, bool) {
	source, err := localworkspace.ClaudeSourceEnvironment(environment)
	if err != nil {
		return gatewayEndpoint{}, false
	}
	base := strings.TrimRight(strings.TrimSpace(source["ANTHROPIC_BASE_URL"]), "/")
	if base == "" || (source["ANTHROPIC_AUTH_TOKEN"] == "" && source["ANTHROPIC_API_KEY"] == "") {
		return gatewayEndpoint{}, false
	}
	return gatewayEndpoint{baseURL: base + "/v1", token: source["ANTHROPIC_AUTH_TOKEN"], apiKey: source["ANTHROPIC_API_KEY"]}, true
}

// claudeGatewayModelID names a Claude model as its gateway lists it: the
// concrete model an alias runs, without the [1m] context variant suffix
// Claude removes before it sends the name.
func claudeGatewayModelID(model RuntimeModel) string {
	id := model.ID
	if model.resolved != "" {
		id = model.resolved
	}
	return strings.TrimSuffix(id, "[1m]")
}

// piGatewayProviders reads the API links in models.json: the providers it
// points at a base URL, keyed by provider name. A built-in provider without
// one is the subscription link. An apiKey resolves as Pi resolves it, except that a
// "!command" key is never run during discovery and the request goes unsigned.
func piGatewayProviders(environment map[string]string) map[string]gatewayEndpoint {
	source, err := localworkspace.PiSourceEnvironment(environment)
	if err != nil {
		return nil
	}
	data, err := readRuntimeConfig(filepath.Join(source["PI_CODING_AGENT_DIR"], "models.json"))
	if err != nil {
		return nil
	}
	var config struct {
		Providers map[string]json.RawMessage `json:"providers"`
	}
	if json.Unmarshal(data, &config) != nil {
		return nil
	}
	providers := map[string]gatewayEndpoint{}
	for name, raw := range config.Providers {
		var provider struct {
			BaseURL string `json:"baseUrl"`
			APIKey  string `json:"apiKey"`
		}
		if json.Unmarshal(raw, &provider) != nil || strings.TrimSpace(provider.BaseURL) == "" {
			continue
		}
		providers[name] = gatewayEndpoint{baseURL: provider.BaseURL, token: piConfigValue(provider.APIKey, environment)}
	}
	return providers
}

// piConfigValue expands Pi's config value template: $NAME and ${NAME} read the
// environment, $$ and $! escape a literal character, and anything else is
// literal. A missing variable or a "!command" value yields no token.
func piConfigValue(value string, environment map[string]string) string {
	if strings.HasPrefix(value, "!") {
		return ""
	}
	var resolved strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] != '$' || i+1 == len(value) {
			resolved.WriteByte(value[i])
			continue
		}
		next := value[i+1]
		var name string
		var end int
		switch {
		case next == '$' || next == '!':
			resolved.WriteByte(next)
			i++
			continue
		case next == '{':
			closing := strings.IndexByte(value[i+2:], '}')
			if closing < 0 {
				resolved.WriteByte('$')
				continue
			}
			name, end = value[i+2:i+2+closing], i+2+closing
			if !piEnvironmentName.MatchString(name) {
				resolved.WriteString(value[i : end+1])
				i = end
				continue
			}
		default:
			name = piEnvironmentPrefix.FindString(value[i+1:])
			if name == "" {
				resolved.WriteByte('$')
				continue
			}
			end = i + len(name)
		}
		variable := environment[name]
		if variable == "" {
			return ""
		}
		resolved.WriteString(variable)
		i = end
	}
	return resolved.String()
}

var (
	piEnvironmentName   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	piEnvironmentPrefix = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*`)
)

// codexCatalogContextLengths reads the context_window Codex's own model
// catalog file (model_catalog_json, top level or the active profile) declares
// for each model slug. Codex's bundled catalog is not a file and stays
// unknown.
func codexCatalogContextLengths(environment map[string]string) map[string]int {
	home := strings.TrimSpace(environment["CODEX_HOME"])
	if home == "" {
		return nil
	}
	data, err := readRuntimeConfig(filepath.Join(home, "config.toml"))
	if err != nil {
		return nil
	}
	var config struct {
		ModelCatalogJSON string `toml:"model_catalog_json"`
		Profile          string `toml:"profile"`
		Profiles         map[string]struct {
			ModelCatalogJSON string `toml:"model_catalog_json"`
		} `toml:"profiles"`
	}
	if toml.Unmarshal(data, &config) != nil {
		return nil
	}
	path := config.ModelCatalogJSON
	if profile, ok := config.Profiles[config.Profile]; config.Profile != "" && ok && profile.ModelCatalogJSON != "" {
		path = profile.ModelCatalogJSON
	}
	switch {
	case path == "":
		return nil
	case strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`):
		path = filepath.Join(environment["HOME"], path[2:])
	case !filepath.IsAbs(path):
		path = filepath.Join(home, path)
	}
	return codexCatalogFileContextLengths(path)
}

// codexModelsCacheContextLengths reads the models_cache.json Codex writes
// into its home when it lists the subscription's models, which discovery has
// just done in the home it ran Codex with.
func codexModelsCacheContextLengths(environment map[string]string) map[string]int {
	home := strings.TrimSpace(environment["CODEX_HOME"])
	if home == "" {
		return nil
	}
	return codexCatalogFileContextLengths(filepath.Join(home, "models_cache.json"))
}

// codexCatalogFileContextLengths reads a file in Codex's model catalog shape,
// as model_catalog_json and models_cache.json share it.
func codexCatalogFileContextLengths(path string) map[string]int {
	data, err := readRuntimeConfig(path)
	if err != nil {
		return nil
	}
	var catalog struct {
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(data, &catalog) != nil {
		return nil
	}
	windows := map[string]int{}
	for _, raw := range catalog.Models {
		var model struct {
			Slug          string          `json:"slug"`
			ContextWindow json.RawMessage `json:"context_window"`
		}
		if json.Unmarshal(raw, &model) != nil || model.Slug == "" {
			continue
		}
		if window, ok := contextWindowValue(string(model.ContextWindow)); ok {
			windows[model.Slug] = window
		}
	}
	return windows
}

func readRuntimeConfig(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, runtimeConfigMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > runtimeConfigMaxBytes {
		return nil, errors.New("Runtime configuration is too large")
	}
	return data, nil
}

// gatewayContextWindows lists the gateway's models and returns every listed
// id with the context window it states, zero when it states none. Gateways
// name the field differently: Magpie sends context_window, Bifrost
// context_length, others max_input_tokens.
func gatewayContextWindows(ctx context.Context, endpoint gatewayEndpoint) (map[string]int, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(endpoint.baseURL), "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return nil, errors.New("model gateway base URL is invalid")
	}
	ctx, cancel := context.WithTimeout(ctx, gatewayModelsTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String()+"/models", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if endpoint.token != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.token)
	}
	if endpoint.apiKey != "" {
		request.Header.Set("X-Api-Key", endpoint.apiKey)
		request.Header.Set("Anthropic-Version", anthropicAPIVersion)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("model gateway listed models with status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, gatewayModelsMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > gatewayModelsMaxBytes {
		return nil, errors.New("model gateway model list is too large")
	}
	var list struct {
		Data []json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &list) != nil {
		return nil, errors.New("model gateway model list is invalid")
	}
	windows := map[string]int{}
	for _, raw := range list.Data {
		var entry struct {
			ID             string          `json:"id"`
			ContextWindow  json.RawMessage `json:"context_window"`
			ContextLength  json.RawMessage `json:"context_length"`
			MaxInputTokens json.RawMessage `json:"max_input_tokens"`
		}
		if json.Unmarshal(raw, &entry) != nil || entry.ID == "" {
			continue
		}
		window := 0
		for _, value := range []json.RawMessage{entry.ContextWindow, entry.ContextLength, entry.MaxInputTokens} {
			if stated, ok := contextWindowValue(string(value)); ok {
				window = stated
				break
			}
		}
		windows[entry.ID] = max(windows[entry.ID], window)
	}
	return windows, nil
}

// gatewayWindow returns the window a gateway list gives a Runtime model id:
// the entry listed under that id, or else the one entry listed as
// <provider>/<id>. Bifrost lists each model under its provider while requests
// name the model alone; a name two providers list stays unknown.
func gatewayWindow(windows map[string]int, id string) int {
	if window, listed := windows[id]; listed {
		return window
	}
	window, matches := 0, 0
	for listedID, listedWindow := range windows {
		if provider, name, ok := strings.Cut(listedID, "/"); ok && provider != "" && name == id {
			window, matches = listedWindow, matches+1
		}
	}
	if matches != 1 {
		return 0
	}
	return window
}

// contextWindowValue accepts a positive integer token count within bounds.
func contextWindowValue(value string) (int, bool) {
	window, err := strconv.Atoi(strings.TrimSpace(value))
	return window, err == nil && window > 0 && window <= maxModelContextWindow
}
