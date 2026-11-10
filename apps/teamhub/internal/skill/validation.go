package skill

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	MaxSchemaBytes = 64 << 10
	MaxSchemaDepth = 20
	MaxSchemaNodes = 1000
	MaxConfigBytes = 32 << 10
)

var forbiddenKeys = map[string]struct{}{
	"api_key": {}, "apikey": {}, "password": {}, "passwd": {}, "secret": {},
	"token": {}, "access_token": {}, "refresh_token": {}, "credential": {}, "credentials": {},
	"authorization": {}, "bearer": {}, "cookie": {}, "session": {}, "private_key": {}, "client_secret": {},
	"code": {}, "executable": {}, "package": {}, "package_url": {}, "install_url": {},
	"git_url": {}, "oci_url": {}, "x_install_url": {}, "npm": {}, "pip": {}, "binary": {}, "bytes": {},
}

// TeamHub stores only auditable Skill declarations and configuration, and does not extend the configuration surface into runtime credentials,
// install sources, or entry points for executable content; manifests and instance configuration therefore share this set of field checks.

// ValidateManifest validates and compiles the Skill's configuration Schema.
func ValidateManifest(raw json.RawMessage) (*jsonschema.Schema, error) {
	if len(raw) == 0 || len(raw) > MaxSchemaBytes {
		return nil, errors.New("config_schema exceeds the size limit")
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("invalid config_schema: %w", err)
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, errors.New("config_schema must be an object")
	}
	if err := inspect(value, 0, new(int), true); err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("urn:teamhub:skill-config", value); err != nil {
		return nil, fmt.Errorf("invalid config_schema: %w", err)
	}
	compiled, err := compiler.Compile("urn:teamhub:skill-config")
	if err != nil {
		return nil, fmt.Errorf("invalid config_schema: %w", err)
	}
	return compiled, nil
}

// ValidateConfig rejects sensitive fields and validates the Skill configuration against the compiled Schema.
func ValidateConfig(schema *jsonschema.Schema, raw json.RawMessage) error {
	if len(raw) == 0 || len(raw) > MaxConfigBytes {
		return errors.New("config exceeds the size limit")
	}
	if err := RejectSensitiveConfig(raw); err != nil {
		return err
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return errors.New("config is invalid JSON")
	}
	if _, ok := value.(map[string]any); !ok {
		return errors.New("config must be an object")
	}
	if err := schema.Validate(value); err != nil {
		return fmt.Errorf("config does not match manifest schema: %w", err)
	}
	return nil
}

// RejectSensitiveConfig checks whether the configuration contains a forbidden field name.
// It is not a secret-content scanner and does not provide a code execution sandbox.
func RejectSensitiveConfig(raw json.RawMessage) error {
	if len(raw) > MaxConfigBytes {
		return errors.New("config exceeds the size limit")
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return errors.New("config is invalid JSON")
	}
	return inspect(value, 0, new(int), false)
}

func inspect(value any, depth int, nodes *int, manifest bool) error {
	// The depth, node-count, and raw-byte limits together bound the recursive validation cost, but are not strict CPU or memory quotas.
	if depth > MaxSchemaDepth {
		return errors.New("JSON structure exceeds the depth limit")
	}
	*nodes++
	if *nodes > MaxSchemaNodes {
		return errors.New("JSON structure exceeds the complexity limit")
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", "_"), " ", "_"))
			if _, forbidden := forbiddenKeys[normalized]; forbidden {
				return fmt.Errorf("field %q is forbidden", key)
			}
			if strings.Contains(normalized, "credential") || strings.HasSuffix(normalized, "_secret") || strings.HasSuffix(normalized, "_password") || strings.HasSuffix(normalized, "_api_key") || normalized == "x-install-url" {
				return fmt.Errorf("field %q is forbidden", key)
			}
			if manifest && (key == "$ref" || key == "$dynamicRef" || key == "$recursiveRef") {
				// Only fragment-only references are allowed, so compiling the Schema never resolves remote resources.
				ref, ok := child.(string)
				if !ok || !strings.HasPrefix(ref, "#") {
					return errors.New("config_schema may use only local JSON Schema references")
				}
			}
			if err := inspect(child, depth+1, nodes, manifest); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := inspect(child, depth+1, nodes, manifest); err != nil {
				return err
			}
		}
	}
	return nil
}
