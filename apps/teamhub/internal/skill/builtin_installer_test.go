package skill

import (
	"errors"
	"slices"
	"testing"
)

func TestSkillPolicyPlanInstallsLatest(t *testing.T) {
	plan, err := planSkillPolicy(currentSkillPolicy{defaultAgentTypes: []string{"general"}}, "1.0.0", []string{"general"})
	if err != nil {
		t.Fatal(err)
	}
	if plan != (skillPolicyPlan{setLatest: true}) {
		t.Fatalf("first install plan=%+v", plan)
	}
}

func TestSkillPolicyPlanIsIdempotentForSameCatalog(t *testing.T) {
	current := currentSkillPolicy{latestVersion: "1.0.0", defaultAgentTypes: []string{"general"}}
	plan, err := planSkillPolicy(current, "1.0.0", []string{"general"})
	if err != nil {
		t.Fatal(err)
	}
	if plan != (skillPolicyPlan{}) {
		t.Fatalf("exact replay writes policy: %+v", plan)
	}
}

func TestSkillPolicyPlanAdvancesLatestAndChangedDefaults(t *testing.T) {
	current := currentSkillPolicy{latestVersion: "1.0.0", defaultAgentTypes: []string{"general"}}
	plan, err := planSkillPolicy(current, "1.0.1", []string{"anotherme"})
	if err != nil {
		t.Fatal(err)
	}
	if plan != (skillPolicyPlan{setLatest: true, setDefaults: true}) {
		t.Fatalf("advance plan=%+v", plan)
	}
}

func TestSkillPolicyPlanAdvancesLatestKeepsUnchangedDefaults(t *testing.T) {
	current := currentSkillPolicy{latestVersion: "1.0.0", defaultAgentTypes: []string{"general"}}
	plan, err := planSkillPolicy(current, "1.0.1", []string{"general"})
	if err != nil {
		t.Fatal(err)
	}
	if plan != (skillPolicyPlan{setLatest: true}) {
		t.Fatalf("advance plan=%+v", plan)
	}
}

func TestSkillPolicyPlanEqualVersionWritesChangedDefaultsOnly(t *testing.T) {
	current := currentSkillPolicy{latestVersion: "1.0.1", defaultAgentTypes: []string{"general"}}
	plan, err := planSkillPolicy(current, "1.0.1", []string{})
	if err != nil {
		t.Fatal(err)
	}
	if plan != (skillPolicyPlan{setDefaults: true}) {
		t.Fatalf("equal version plan=%+v", plan)
	}
}

func TestSkillPolicyPlanOlderCatalogWritesNothing(t *testing.T) {
	current := currentSkillPolicy{latestVersion: "1.0.1", defaultAgentTypes: []string{"general"}}
	plan, err := planSkillPolicy(current, "1.0.0", []string{"anotherme"})
	if err != nil {
		t.Fatal(err)
	}
	if plan != (skillPolicyPlan{}) {
		t.Fatalf("older catalog wrote policy: %+v", plan)
	}
}

func TestSkillPolicyPlanComparesVersionsNumerically(t *testing.T) {
	current := currentSkillPolicy{latestVersion: "1.9.0", defaultAgentTypes: []string{}}
	plan, err := planSkillPolicy(current, "1.10.0", []string{})
	if err != nil {
		t.Fatal(err)
	}
	if plan != (skillPolicyPlan{setLatest: true}) {
		t.Fatalf("1.10.0 over 1.9.0 plan=%+v", plan)
	}
}

func TestSkillPolicyPlanRejectsNonSemverVersions(t *testing.T) {
	current := currentSkillPolicy{latestVersion: "1.0.0", defaultAgentTypes: []string{}}
	for _, catalogVersion := range []string{"1.0", "1.0.0-rc.1", "01.0.0", "v1.0.0"} {
		if _, err := planSkillPolicy(current, catalogVersion, []string{}); !errors.Is(err, ErrBuiltinSkillConflict) {
			t.Fatalf("catalog version %q error=%v, want conflict", catalogVersion, err)
		}
	}
	current.latestVersion = "1.0.0+build.1"
	if _, err := planSkillPolicy(current, "1.0.0", []string{}); !errors.Is(err, ErrBuiltinSkillConflict) {
		t.Fatalf("current version error=%v, want conflict", err)
	}
}

func TestMergeAgentTypesKeepsCanonicalOrder(t *testing.T) {
	got := mergeAgentTypes([]string{"general", "anotherme"}, []string{"general"})
	if !slices.Equal(got, []string{"anotherme", "general"}) {
		t.Fatalf("merged Agent Types=%v", got)
	}
}

func TestCompatibleMediaTypeAcceptsOnlyLegacyMissingUTF8Charset(t *testing.T) {
	for _, test := range []struct {
		persisted string
		expected  string
		want      bool
	}{
		{persisted: "text/markdown", expected: "text/markdown; charset=utf-8", want: true},
		{persisted: "text/markdown; charset=utf-8", expected: "text/markdown; charset=utf-8", want: true},
		{persisted: "text/plain", expected: "text/markdown; charset=utf-8", want: false},
		{persisted: "text/markdown; charset=us-ascii", expected: "text/markdown; charset=utf-8", want: false},
		{persisted: "application/json", expected: "application/json", want: true},
	} {
		if got := compatibleMediaType(test.persisted, test.expected); got != test.want {
			t.Errorf("compatibleMediaType(%q,%q)=%t want %t", test.persisted, test.expected, got, test.want)
		}
	}
}
