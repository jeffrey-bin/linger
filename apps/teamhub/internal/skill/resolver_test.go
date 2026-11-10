package skill

import (
	"bytes"
	"errors"
	"fmt"
	"testing"
)

func TestRetiredBuilderIdentityCannotResolveSkills(t *testing.T) {
	identity := Identity{AgentID: "agent", AgentActorID: "actor", TenantID: "tenant", AgentType: "builder"}
	if validIdentity(identity) || validPolicyIdentity(identity) {
		t.Fatal("retired Builder identity was accepted for Skill resolution")
	}
	for _, agentType := range []string{"general", "anotherme"} {
		identity.AgentType = agentType
		if !validIdentity(identity) {
			t.Fatalf("ordinary %s identity was rejected", agentType)
		}
	}
}

func TestEffectiveDigestIsStableAcrossConfigMapOrder(t *testing.T) {
	first, err := effectiveDigest([]Item{{
		SkillID: "simplexai_collaborate", ManifestID: "skill_manifest_collaborate_v1",
		ManifestVersion: "1.0.0", Name: "collaborate", PackageSHA256: stringOf('a', 64),
		Source: "default", Config: map[string]any{"z": float64(2), "a": "value"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := effectiveDigest([]Item{{
		SkillID: "simplexai_collaborate", ManifestID: "skill_manifest_collaborate_v1",
		ManifestVersion: "1.0.0", Name: "collaborate", PackageSHA256: stringOf('a', 64),
		Source: "default", Config: map[string]any{"a": "value", "z": float64(2)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("equivalent effective sets produced different digests: %x != %x", first, second)
	}
}

func TestValidateResolvedItemsRejectsBaselineIdentityNameAndCapacityConflicts(t *testing.T) {
	base := func(index int) Item {
		return Item{
			SkillID: fmt.Sprintf("skill_%03d", index), ManifestID: fmt.Sprintf("manifest_%03d", index),
			Name: fmt.Sprintf("skill-%03d", index), Source: "default", Config: map[string]any{},
		}
	}
	tests := []struct {
		name  string
		items []Item
	}{
		{
			name: "Skill ID",
			items: []Item{
				base(1),
				{SkillID: "skill_001", ManifestID: "manifest_other", Name: "other", Source: "default", Config: map[string]any{}},
			},
		},
		{
			name: "runtime name",
			items: []Item{
				base(1),
				{SkillID: "skill_other", ManifestID: "manifest_other", Name: "SKILL-001", Source: "default", Config: map[string]any{}},
			},
		},
		{name: "capacity", items: func() []Item {
			items := make([]Item, maxSkills+1)
			for index := range items {
				items[index] = base(index)
			}
			return items
		}()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := validateResolvedItems(test.items); !errors.Is(err, ErrConflict) {
				t.Fatalf("validate conflict error=%v, want ErrConflict", err)
			}
		})
	}
}

func stringOf(value byte, count int) string {
	result := make([]byte, count)
	for index := range result {
		result[index] = value
	}
	return string(result)
}
