package computerconfig

import "testing"

func TestRuntimeEnvironmentRejectsControlPlaneCredentials(t *testing.T) {
	source := map[string]string{
		"PATH":                            "/usr/bin",
		"ANTHROPIC_API_KEY":               "provider-key",
		"CODEX_AGENT_TIMEOUT":             "30m",
		"LINGER_SERVER_URL":               "https://linger.example",
		"linger_token":                    "linger-token",
		"LINGER_LLM_API_KEY":              "linger-llm-key",
		"LINGER_GATEWAY_TOKEN":            "linger-token",
		"UNRELATED_GATEWAY_TOKEN_COPY":    "linger-token",
		"LINGER_COMPUTER_SERVICE_COMMAND": `["/bin/linger-computer","--config","/c.json"]`,
	}
	got := RuntimeEnvironment(source, "linger-token")
	for _, key := range []string{"LINGER_SERVER_URL", "linger_token", "LINGER_LLM_API_KEY", "LINGER_GATEWAY_TOKEN", "UNRELATED_GATEWAY_TOKEN_COPY", "LINGER_COMPUTER_SERVICE_COMMAND"} {
		if _, exists := got[key]; exists {
			t.Fatalf("control value %q reached Runtime environment", key)
		}
	}
	if got["PATH"] != "/usr/bin" || got["ANTHROPIC_API_KEY"] != "provider-key" || got["CODEX_AGENT_TIMEOUT"] != "30m" {
		t.Fatalf("Runtime environment lost allowed values: %#v", got)
	}
}
