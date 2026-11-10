package workspace

import (
	"encoding/json"
	"errors"
	"io"
	"maps"
	"os"
	"path/filepath"
)

// ClaudeSourceEnvironment returns a copy of environment with the
// authentication and model variables the user's Claude settings declare, as
// a managed Claude process sees them; explicit values win.
func ClaudeSourceEnvironment(environment map[string]string) (map[string]string, error) {
	result := maps.Clone(environment)
	if result == nil {
		result = map[string]string{}
	}
	source := result["CLAUDE_CONFIG_DIR"]
	if source == "" {
		if result["HOME"] == "" {
			return result, nil
		}
		source = filepath.Join(result["HOME"], ".claude")
	}
	if err := inheritClaudeAuthEnvironment(source, result); err != nil {
		return nil, err
	}
	return result, nil
}

func inheritClaudeAuthEnvironment(source string, environment map[string]string) error {
	file, err := os.Open(filepath.Join(source, "settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("Claude local settings could not be opened")
	}
	defer file.Close()
	const maxSettingsBytes = 1024 * 1024
	content, err := io.ReadAll(io.LimitReader(file, maxSettingsBytes+1))
	if err != nil || len(content) > maxSettingsBytes {
		return errors.New("Claude local settings could not be read within the size limit")
	}
	var settings map[string]json.RawMessage
	if json.Unmarshal(content, &settings) != nil || settings == nil {
		return errors.New("Claude local settings must be a JSON object")
	}
	encoded, present := settings["env"]
	if !present {
		return nil
	}
	var values map[string]json.RawMessage
	if json.Unmarshal(encoded, &values) != nil || values == nil {
		return errors.New("Claude local settings env must be a JSON object")
	}
	inherited := make(map[string]string)
	for _, name := range []string{
		"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
		"ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
		"ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
		"ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
	} {
		encoded, present := values[name]
		if !present {
			continue
		}
		var value *string
		if json.Unmarshal(encoded, &value) != nil || value == nil {
			return errors.New("Claude local authentication or model environment value must be a string: " + name)
		}
		inherited[name] = *value
	}
	if environment == nil {
		return errors.New("Claude runtime environment is unavailable")
	}
	for name, value := range inherited {
		if _, explicit := environment[name]; !explicit {
			environment[name] = value
		}
	}
	return nil
}
