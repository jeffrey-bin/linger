package demodata

import "testing"

func TestValidateE2EIdentityConfigRequiresExplicitEnablement(t *testing.T) {
	config := E2EIdentityConfig{
		RunID:       "cards-files-20260823",
		Email:       "cards-files-20260823@example.test",
		Password:    "local-e2e-password",
		DisplayName: "Conversation Audit",
	}
	if err := validateE2EIdentityConfig(config); err == nil {
		t.Fatal("validateE2EIdentityConfig accepted disabled E2E identity provisioning")
	}
	config.Enabled = true
	if err := validateE2EIdentityConfig(config); err != nil {
		t.Fatalf("validate enabled E2E identity config: %v", err)
	}
}

func TestValidateE2EIdentityConfigRejectsUnsafeInputs(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*E2EIdentityConfig)
	}{
		{name: "short password", mutate: func(config *E2EIdentityConfig) { config.Password = "short" }},
		{name: "invalid email", mutate: func(config *E2EIdentityConfig) { config.Email = "not-an-email" }},
		{name: "unsafe run id", mutate: func(config *E2EIdentityConfig) { config.RunID = "../../shared" }},
		{name: "empty display name", mutate: func(config *E2EIdentityConfig) { config.DisplayName = "" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := E2EIdentityConfig{
				Enabled:     true,
				RunID:       "cards-files-20260823",
				Email:       "cards-files-20260823@example.test",
				Password:    "local-e2e-password",
				DisplayName: "Conversation Audit",
			}
			test.mutate(&config)
			if err := validateE2EIdentityConfig(config); err == nil {
				t.Fatal("validateE2EIdentityConfig accepted unsafe input")
			}
		})
	}
}
