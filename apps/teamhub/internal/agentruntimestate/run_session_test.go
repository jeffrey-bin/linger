package agentruntimestate

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// This invariant moved from the retired Agent SQLite store to TeamHub authority.
func TestRuntimeSessionRejectsPersistedCredentials(t *testing.T) {
	for _, secret := range []string{"mcp_ctx_" + strings.Repeat("A", 43), "cli_ctx_" + strings.Repeat("S", 43)} {
		for _, session := range []map[string]any{
			{"threadId": "thread-1", "opaque": secret},
			{"threadId": "thread-1", "mcpServers": []any{map[string]any{"httpHeaders": map[string]any{"Authorization": "Bearer " + secret}}}},
		} {
			raw, err := json.Marshal(session)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = validateRuntimeSession(RuntimeSessionCheckpoint{ProviderKind: "codex", ThreadID: "thread-1", Session: raw}); !errors.Is(err, ErrInvalid) {
				t.Fatalf("credential persisted: error=%v", err)
			}
		}
	}
	safe := json.RawMessage(`{"threadId":"thread-1","mcpServerNames":["linger_teamhub_collaboration"],"mcpServerTransports":[{"name":"linger_teamhub_collaboration","url":"http://127.0.0.1:8090/mcp/teamhub-collaboration"}]}`)
	if _, err := validateRuntimeSession(RuntimeSessionCheckpoint{ProviderKind: "codex", ThreadID: "thread-1", Session: safe}); err != nil {
		t.Fatalf("credential-free provider session: %v", err)
	}
}

func TestRuntimeSessionExecutionResourcesEnvelope(t *testing.T) {
	resources := map[string]any{"version": 1, "effectiveSha256": strings.Repeat("a", 64), "skills": []any{map[string]any{
		"skillId": "skill-one", "manifestId": "manifest-one", "manifestVersion": "1.0.0", "name": "skill-one", "packageName": "skill-one",
		"packageSha256": strings.Repeat("b", 64), "source": "explicit", "config": map[string]any{},
	}}}
	check := func(t *testing.T, native any, thread string, mutate func(map[string]any), want error) {
		t.Helper()
		encoded, _ := json.Marshal(map[string]any{"nativeSession": native, "executionResources": resources})
		var session map[string]any
		_ = json.Unmarshal(encoded, &session)
		if mutate != nil {
			mutate(session)
		}
		encoded, _ = json.Marshal(session)
		_, err := validateRuntimeSession(RuntimeSessionCheckpoint{SchemaVersion: 2, ProviderKind: "codex", ThreadID: thread, Session: encoded})
		if !errors.Is(err, want) {
			t.Fatalf("session=%s error=%v want=%v", encoded, err, want)
		}
	}
	t.Run("no pinned profile", func(t *testing.T) {
		check(t, nil, "", func(s map[string]any) {
			s["executionResources"].(map[string]any)["userProfile"] = map[string]any{"revisionId": "profile_7", "markdown": "body"}
		}, ErrInvalid)
	})
	t.Run("preparation before native thread", func(t *testing.T) { check(t, nil, "", nil, nil) })
	t.Run("native history", func(t *testing.T) { check(t, map[string]any{"threadId": "thread-1"}, "thread-1", nil, nil) })
	t.Run("indexed native mismatch", func(t *testing.T) { check(t, map[string]any{"threadId": "other"}, "thread-1", nil, ErrConflict) })
	t.Run("null native with thread", func(t *testing.T) { check(t, nil, "thread-1", nil, ErrInvalid) })
	for _, field := range []string{"snapshotToken", "unknown"} {
		t.Run(field, func(t *testing.T) { check(t, nil, "", func(s map[string]any) { s[field] = "value" }, ErrInvalid) })
	}
	for _, field := range []string{"effectiveSha256", "version", "skills"} {
		t.Run("missing "+field, func(t *testing.T) {
			check(t, nil, "", func(s map[string]any) { delete(s["executionResources"].(map[string]any), field) }, ErrInvalid)
		})
	}
	t.Run("duplicate exact descriptor", func(t *testing.T) {
		check(t, nil, "", func(s map[string]any) {
			r := s["executionResources"].(map[string]any)
			skills := r["skills"].([]any)
			r["skills"] = append(skills, skills[0])
		}, ErrInvalid)
	})
	t.Run("digest format", func(t *testing.T) {
		check(t, nil, "", func(s map[string]any) { s["executionResources"].(map[string]any)["effectiveSha256"] = "invalid" }, ErrInvalid)
	})
	t.Run("token in config", func(t *testing.T) {
		check(t, nil, "", func(s map[string]any) {
			s["executionResources"].(map[string]any)["skills"].([]any)[0].(map[string]any)["config"] = map[string]any{"secret": "cli_ctx_" + strings.Repeat("x", 43)}
		}, ErrInvalid)
	})
	t.Run("null run reference", func(t *testing.T) {
		check(t, nil, "", func(s map[string]any) { s["executionResources"].(map[string]any)["executionRunRef"] = nil }, ErrInvalid)
	})
	t.Run("missing native thread", func(t *testing.T) { check(t, map[string]any{}, "thread-1", nil, ErrConflict) })
}
