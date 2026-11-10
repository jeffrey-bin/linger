package redact

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestDiagnosticBoundaries(t *testing.T) {
	for _, tc := range []struct{ input, expected string }{
		{`{"api-key":"synthetic credential with spaces","line":7}`, `{"api-key":"[REDACTED]","line":7}`},
		{`password="a\"b" next=ok`, `password="[REDACTED]" next=ok`},
		{"Authorization: Custom fixture-value\r\nnext: ok", "Authorization: [REDACTED]\r\nnext: ok"},
		{"Cookie: session=fixture; another=value\n", "Cookie: [REDACTED]\n"},
		{"DATABASE_URL=postgresql://test:fixture@localhost/db next=ok", "DATABASE_URL=[REDACTED] next=ok"},
		{"https://test:fixture@proxy.example.test/path", "https://[REDACTED]@proxy.example.test/path"},
		{"Bearer fixture+/==", "Bearer [REDACTED]"},
		{"API_SECRET: sample; next=7", "API_SECRET: [REDACTED]; next=7"},
		{"-----BEGIN RSA PRIVATE KEY-----\nfixture\n-----END RSA PRIVATE KEY-----\nnext", "[REDACTED PRIVATE KEY]\nnext"},
		{"-----BEGIN PRIVATE KEY-----\nincomplete", "[REDACTED PRIVATE KEY]"},
	} {
		got := Text(tc.input)
		if got != tc.expected {
			t.Errorf("input %q: got %q, want %q", tc.input, got, tc.expected)
		}
		if Text(got) != got {
			t.Errorf("not idempotent: %q", got)
		}
	}
}

func TestRecognizableTokensWithoutFieldNames(t *testing.T) {
	for _, prefix := range []string{"sk-", "github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "glpat-", "xoxb-", "xoxe-", "xapp-", "sk_live_", "rk_live_"} {
		token := prefix + strings.Repeat("Z7", 24)
		out := Text("first: '" + token + "'. next: ok")
		if strings.Contains(out, token) || !strings.HasSuffix(out, "'. next: ok") {
			t.Errorf("bad boundary for %s: %q", prefix, out)
		}
	}
	for _, token := range []string{"AKIA" + strings.Repeat("Q", 16), "AIza" + strings.Repeat("a", 34) + "-", "ey" + strings.Repeat("a", 12) + "." + strings.Repeat("b", 12) + "." + strings.Repeat("c", 12)} {
		if got := Text("value=" + token + "."); strings.Contains(got, token) || !strings.HasSuffix(got, ".") {
			t.Errorf("token not bounded: %q", got)
		}
	}
}

func TestOrdinaryDiagnosticDataSurvives(t *testing.T) {
	for _, input := range []string{"/Users/example/project/api_key.go:12", "token_count=5 password_length=8", "sk-short", "pk_live_public_fixture", "https://example.test/a?q=1", "Compilation échouée : fichier introuvable\nnext line", "-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----"} {
		if got := Text(input); got != input {
			t.Errorf("changed ordinary data %q to %q", input, got)
		}
	}
}

func TestStructuredCopiesAndSensitiveKeys(t *testing.T) {
	input := map[string]any{"edits": []any{map[string]any{"content": "AUTH_TOKEN=fixture", "line": 12}}, "env": map[string]string{"PASSWORD": "fixture", "PATH": "/bin"}, "argv": []string{"Bearer fixture", "--help"}, "token": 123, "nil": nil}
	before, _ := json.Marshal(input)
	got := InputMap(input)
	after, _ := json.Marshal(input)
	if string(before) != string(after) {
		t.Fatal("input was mutated")
	}
	encoded, _ := json.Marshal(got)
	if strings.Contains(string(encoded), "fixture") || got["token"] != hidden {
		t.Fatalf("credential survived: %s", encoded)
	}
	if got["edits"].([]any)[0].(map[string]any)["line"] != 12 || got["env"].(map[string]string)["PATH"] != "/bin" {
		t.Fatal("ordinary data changed")
	}
	if !reflect.DeepEqual(got, InputMap(got)) {
		t.Fatal("structured redaction is not idempotent")
	}
	if InputMap(nil) != nil {
		t.Fatal("nil map changed")
	}
}

func TestCyclicToolInputsFailClosed(t *testing.T) {
	input := map[string]any{}
	input["next"] = input
	encoded, err := json.Marshal(InputMap(input))
	if err != nil || !strings.Contains(string(encoded), depthLimitPlaceholder) {
		t.Fatalf("unbounded cycle: %s %v", encoded, err)
	}
}

func FuzzDiagnosticIdempotence(f *testing.F) {
	for _, s := range []string{"Bearer fixture", "password=\"a b\"", "https://a:b@example.test", "-----BEGIN PRIVATE KEY-----\nfixture", "ordinary text"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		first := Text(s)
		if Text(first) != first {
			t.Fatalf("not idempotent for %q: %q -> %q", s, first, Text(first))
		}
	})
}

func TestSensitiveFieldMasksTheEntireValue(t *testing.T) {
	for _, value := range []string{"ordinary-secret sk-" + strings.Repeat("X", 30), "Bearer synthetic", "[REDACTED] trailing-secret", "plain secret"} {
		safe := InputMap(map[string]any{"password": value})
		if safe["password"] != hidden {
			t.Fatalf("partial sensitive value escaped: %q", safe["password"])
		}
		if !reflect.DeepEqual(safe, InputMap(safe)) {
			t.Fatal("sensitive field masking changed on repetition")
		}
	}
}
