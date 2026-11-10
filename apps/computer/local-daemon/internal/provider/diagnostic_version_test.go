package provider

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWireDiagnosticVersionIsBoundedWithoutMutatingDiscovery(t *testing.T) {
	for _, sample := range []struct{ input, expected string }{
		{"  codex 1.0\r\ninstallation detail", "codex 1.0"},
		{strings.Repeat("€✓", 80), strings.Repeat("€✓", 60)},
		{" \n ", ""},
	} {
		diagnostics := []RuntimeDiagnostic{{Type: "codex", Version: sample.input}}
		encoded, err := DiagnosticsJSON(diagnostics)
		if err != nil {
			t.Fatal(err)
		}
		var decoded []RuntimeDiagnostic
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded[0].Version != sample.expected {
			t.Fatalf("version=%q want=%q", decoded[0].Version, sample.expected)
		}
		if diagnostics[0].Version != sample.input {
			t.Fatal("wire projection mutated discovery")
		}
	}
}
