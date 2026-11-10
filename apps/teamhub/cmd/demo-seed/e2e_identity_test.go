package main

import "testing"

func TestConfigFromEnvironmentMapsExplicitE2EInputs(t *testing.T) {
	values := map[string]string{
		"TEAMHUB_E2E_IDENTITY_ENABLED": "true",
		"TEAMHUB_E2E_RUN_ID":           "cards-files-20260823",
		"TEAMHUB_E2E_EMAIL":            "cards-files-20260823@example.test",
		"TEAMHUB_E2E_PASSWORD":         "local-e2e-password",
		"TEAMHUB_E2E_DISPLAY_NAME":     "Conversation Audit",
	}
	config, err := configFromEnvironment(func(name string) string { return values[name] })
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled || config.RunID != values["TEAMHUB_E2E_RUN_ID"] || config.Email != values["TEAMHUB_E2E_EMAIL"] || config.Password != values["TEAMHUB_E2E_PASSWORD"] || config.DisplayName != values["TEAMHUB_E2E_DISPLAY_NAME"] {
		t.Fatalf("unexpected E2E identity config: %+v", config)
	}
}

func TestConfigFromEnvironmentRejectsInvalidEnablement(t *testing.T) {
	_, err := configFromEnvironment(func(name string) string {
		if name == "TEAMHUB_E2E_IDENTITY_ENABLED" {
			return "sometimes"
		}
		return ""
	})
	if err == nil {
		t.Fatal("configFromEnvironment accepted invalid enablement")
	}
}
