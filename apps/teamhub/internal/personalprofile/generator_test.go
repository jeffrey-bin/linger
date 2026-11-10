package personalprofile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

func TestEmbeddedPersonalProfileSkillMatchesManifest(t *testing.T) {
	raw, err := promptFS.ReadFile("skill/sha256.json")
	if err != nil {
		t.Fatal(err)
	}
	var files map[string]string
	if err = json.Unmarshal(raw, &files); err != nil {
		t.Fatal(err)
	}
	if len(files) != 11 {
		t.Fatalf("package files=%d", len(files))
	}
	for name, expected := range files {
		body, readErr := promptFS.ReadFile("skill/" + name)
		if readErr != nil {
			t.Fatal(readErr)
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != expected {
			t.Fatalf("Skill file does not match package manifest: %s", name)
		}
		if strings.HasSuffix(name, ".md") && !strings.Contains(UserProfileSystemPrompt(PromptVersion), string(body)) {
			t.Fatalf("Skill guidance missing from generation prompt: %s", name)
		}
	}
}

func TestUserProfileGeneratorReturnsOneDocumentFromTheRuntime(t *testing.T) {
	profile := testDocument()
	profile.Name = "  Lin Zhou  "
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		var payload struct {
			Route  json.RawMessage `json:"route"`
			Effort *string         `json:"effort"`
			Owner  struct {
				TenantID     string `json:"tenantId"`
				OwnerActorID string `json:"ownerActorId"`
			} `json:"owner"`
			Instructions string `json:"instructions"`
			Input        string `json:"input"`
			Output       struct {
				Name string `json:"name"`
			} `json:"output"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if request.URL.Path != "/v1/model-calls" || payload.Route != nil || payload.Effort != nil ||
			payload.Owner.TenantID != "tenant_1" || payload.Owner.OwnerActorID != "actor_1" ||
			payload.Output.Name != "personal_profile_supplement" {
			t.Fatalf("unexpected request %s %+v", request.URL.Path, payload)
		}
		if !strings.Contains(payload.Instructions, "user_profile.md") || !strings.Contains(payload.Instructions, "There is no target or maximum") {
			t.Fatal("Skill or host adapter missing")
		}
		if !strings.Contains(payload.Input, "SUBJECT_DISPLAY_NAME ") || !strings.Contains(payload.Input, "BASELINE_PROFILE\n{\"name\":\"Prior\"") {
			t.Fatal("missing baseline")
		}
		encoded, _ := json.Marshal(profile)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"model":"codex","output":{"profile":` + string(encoded) + `,"account":{"name":"Lin Zhou","bio":"Product lead","organization":""}}}`))
	}))
	defer server.Close()
	models, err := roomagent.NewModelCallClient(server.URL, "fixture-key")
	if err != nil {
		t.Fatal(err)
	}
	result, err := NewHTTPGenerator(models, time.Minute).Generate(context.Background(), GenerationRequest{
		TenantID: "tenant_1", OwnerActorID: "actor_1", SubjectDisplayName: "Lin Zhou", PromptVersion: PromptVersion,
		BaselineProfile: `{"name":"Prior"}`, Documents: []GenerationDocument{{Filename: "source.md", Content: "New selected evidence"}},
	})
	if err != nil || result.Error != "" || result.Profile.Name != "Lin Zhou" || calls != 1 {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
	}
}

func TestUserProfilePromptPreservesBaselineAndSourceScope(t *testing.T) {
	system, user := supplementPrompt(GenerationRequest{PromptVersion: PromptVersion, BaselineProfile: "Current derived profile", Documents: []GenerationDocument{{Filename: "selected.md", Content: "New selected evidence"}}})
	for _, rule := range []string{"complete merged document", "Things to Confirm", "TeamHub renders", "source content as evidence"} {
		if !strings.Contains(system, rule) {
			t.Fatalf("missing host usage rule %q", rule)
		}
	}
	if !strings.Contains(user, "Current derived profile") || !strings.Contains(user, "New selected evidence") {
		t.Fatal("missing inputs")
	}
	_, first := supplementPrompt(GenerationRequest{PromptVersion: PromptVersion})
	if strings.Contains(first, "BASELINE_PROFILE") {
		t.Fatal("initial extraction invented a baseline")
	}
}

func TestUserProfileGeneratorDropsTimelineEntriesWithoutPeriodOrOrganization(t *testing.T) {
	expected, err := NormalizeDocument(testDocument())
	if err != nil {
		t.Fatal(err)
	}
	profile := testDocument()
	profile.Background.Timeline = append(profile.Background.Timeline,
		TimelineEntry{Organization: "Kestrel Freight", Role: "Analyst"},
		TimelineEntry{Period: "2012–2014", Role: "Researcher"},
	)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		encoded, _ := json.Marshal(profile)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"model":"codex","output":{"profile":` + string(encoded) + `,"account":{"name":"","bio":"","organization":""}}}`))
	}))
	defer server.Close()
	models, err := roomagent.NewModelCallClient(server.URL, "fixture-key")
	if err != nil {
		t.Fatal(err)
	}
	result, err := NewHTTPGenerator(models, time.Minute).Generate(context.Background(), GenerationRequest{TenantID: "tenant_1", OwnerActorID: "actor_1", PromptVersion: PromptVersion})
	if err != nil || result.Error != "" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	got, _ := json.Marshal(result.Profile.Background.Timeline)
	want, _ := json.Marshal(expected.Background.Timeline)
	if string(got) != string(want) {
		t.Fatalf("timeline=%s want %s", got, want)
	}
}

func TestUserProfileGeneratorRejectsInvalidDocument(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		profile := testDocument()
		profile.WritingStyle = Module{}
		encoded, _ := json.Marshal(profile)
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"model":"codex","output":{"profile":` + string(encoded) + `,"account":{"name":"","bio":"","organization":""}}}`))
	}))
	defer server.Close()
	models, err := roomagent.NewModelCallClient(server.URL, "fixture-key")
	if err != nil {
		t.Fatal(err)
	}
	result, err := NewHTTPGenerator(models, time.Minute).Generate(context.Background(), GenerationRequest{TenantID: "tenant_1", OwnerActorID: "actor_1", PromptVersion: PromptVersion})
	if err != nil || result.Error != "INVALID_PROFILE_OUTPUT" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}
