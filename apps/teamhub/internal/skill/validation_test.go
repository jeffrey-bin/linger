package skill

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateManifestAndConfig(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","additionalProperties":false,"required":["prefix"],"properties":{"prefix":{"type":"string","maxLength":20}}}`)
	compiled, err := ValidateManifest(schema)
	if err != nil {
		t.Fatalf("valid schema: %v", err)
	}
	if err := ValidateConfig(compiled, json.RawMessage(`{"prefix":"summary"}`)); err != nil {
		t.Fatalf("valid config: %v", err)
	}
	if err := ValidateConfig(compiled, json.RawMessage(`{"prefix":42}`)); err == nil {
		t.Fatal("schema-invalid config was accepted")
	}
	for _, value := range []string{
		`{"type":"object","properties":{"api_key":{"type":"string"}}}`,
		`{"type":"object","x-install-url":"https://example.invalid/skill"}`,
		`{"type":"object","executable":"AAAA"}`,
	} {
		if _, err := ValidateManifest(json.RawMessage(value)); err == nil {
			t.Fatalf("forbidden manifest accepted: %s", value)
		}
	}
	if _, err := ValidateManifest(json.RawMessage(`{"type":"object","description":"` + strings.Repeat("x", MaxSchemaBytes) + `"}`)); err == nil {
		t.Fatal("oversized schema was accepted")
	}
	deep := `{"type":"object"}`
	for range MaxSchemaDepth + 1 {
		deep = `{"allOf":[` + deep + `]}`
	}
	if _, err := ValidateManifest(json.RawMessage(deep)); err == nil {
		t.Fatal("overly deep schema was accepted")
	}
}

func TestRejectSensitiveConfigKeys(t *testing.T) {
	for _, value := range []string{
		`{"token":"secret"}`,
		`{"nested":{"password":"secret"}}`,
		`{"credential_value":"secret"}`,
	} {
		if err := RejectSensitiveConfig(json.RawMessage(value)); err == nil {
			t.Fatalf("sensitive config accepted: %s", value)
		}
	}
	if err := RejectSensitiveConfig(json.RawMessage(`{"output_format":"text","token_budget":100}`)); err != nil {
		t.Fatalf("non-secret config rejected: %v", err)
	}
}
