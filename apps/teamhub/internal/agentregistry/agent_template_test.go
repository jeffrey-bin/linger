package agentregistry

import (
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestAgentTemplateModelDecodesStoredSelections(t *testing.T) {
	skills, err := json.Marshal([]httpapi.AgentSkillRegistration{
		{Name: "superpowers", SkillId: "simplexai_superpowers", ManifestVersion: "1.0.0"},
	})
	if err != nil {
		t.Fatalf("encode Skills: %v", err)
	}
	model, err := agentTemplateModel(store.AgentTemplate{
		TemplateID: "code-reviewer", Origin: "builtin", Name: "Code Reviewer",
		Description: "Reviews changes.", Instructions: "Review.",
		AvatarKey:     pgtype.Text{String: "orb-teal", Valid: true},
		SkillBindings: skills, ConnectorBindings: []byte("[]"),
	})
	if err != nil {
		t.Fatalf("build model: %v", err)
	}
	if model.Origin != httpapi.Builtin || model.TemplateId != "code-reviewer" {
		t.Fatalf("unexpected identity: %+v", model)
	}
	if model.AvatarKey == nil || *model.AvatarKey != "orb-teal" {
		t.Fatalf("avatar was not carried: %+v", model.AvatarKey)
	}
	if len(model.SkillBindings) != 1 || model.SkillBindings[0].SkillId != "simplexai_superpowers" {
		t.Fatalf("unexpected Skill selection: %+v", model.SkillBindings)
	}
	// Absent selections must serialize as [] so clients never branch on null.
	if model.ConnectorBindings == nil || model.Routines == nil {
		t.Fatalf("absent selections must not be nil: %+v", model)
	}
}

func TestAgentTemplateModelOmitsAbsentAvatar(t *testing.T) {
	model, err := agentTemplateModel(store.AgentTemplate{
		TemplateID: "helper", Origin: "published", Name: "Helper", Instructions: "Work.",
		SkillBindings: []byte("[]"),
	})
	if err != nil {
		t.Fatalf("build model: %v", err)
	}
	if model.AvatarKey != nil {
		t.Fatalf("want no avatar, got %q", *model.AvatarKey)
	}
}

func TestValidAgentAvatarKeyAcceptsProductSelections(t *testing.T) {
	for _, key := range []string{"orb-indigo", "portrait:3:FF63A0", "orb_sky"} {
		if !ValidAgentAvatarKey(key) {
			t.Fatalf("want %q accepted", key)
		}
	}
	for _, key := range []string{"", "-leading", "has space", "way-too-long-" + string(make([]byte, 80))} {
		if ValidAgentAvatarKey(key) {
			t.Fatalf("want %q rejected", key)
		}
	}
}

func TestAgentTemplateSelectionsUseAgentRegistrationRules(t *testing.T) {
	skills, err := NormalizeAgentSkillRegistrations([]httpapi.AgentSkillRegistration{
		{Name: " taste ", SkillId: "simplexai_taste", ManifestVersion: "1.0.0"},
		{Name: "impeccable", SkillId: "simplexai_impeccable", ManifestVersion: "1.0.0"},
	})
	if err != nil {
		t.Fatalf("normalize Skills: %v", err)
	}
	// Stable order keeps idempotent publication hashes stable across clients.
	if skills[0].SkillId != "simplexai_impeccable" || skills[1].Name != "taste" {
		t.Fatalf("unexpected normalization: %+v", skills)
	}
	if _, err := NormalizeAgentSkillRegistrations([]httpapi.AgentSkillRegistration{
		{Name: "a", SkillId: "simplexai_taste", ManifestVersion: "1.0.0"},
		{Name: "b", SkillId: "simplexai_taste", ManifestVersion: "1.0.0"},
	}); err == nil {
		t.Fatal("want duplicate skill_id rejected")
	}
}

func TestTemplateSkillImportRequiresEmptyConfigSkills(t *testing.T) {
	if !acceptsEmptySkillConfig([]byte(`{"type":"object","additionalProperties":false}`)) {
		t.Fatal("a Skill without required config must be importable")
	}
	if acceptsEmptySkillConfig([]byte(`{"type":"object","required":["region"],"properties":{"region":{"type":"string"}}}`)) {
		t.Fatal("a Skill with required config cannot be bound from a template")
	}
}

func TestPublishedTemplateEncodesOmittedBindingsAsEmptyArrays(t *testing.T) {
	var request httpapi.AgentTemplatePublishRequest
	if err := json.Unmarshal([]byte(`{"name":"Helper","instructions":"Work."}`), &request); err != nil {
		t.Fatal(err)
	}
	skills, err := json.Marshal(emptySlice(pointerSlice(request.SkillBindings)))
	if err != nil || string(skills) != "[]" {
		t.Fatalf("skill_bindings encoded as %s (error %v), want []", skills, err)
	}
	connectors, err := json.Marshal(emptySlice(pointerSlice(request.ConnectorBindings)))
	if err != nil || string(connectors) != "[]" {
		t.Fatalf("connector_bindings encoded as %s (error %v), want []", connectors, err)
	}
}
