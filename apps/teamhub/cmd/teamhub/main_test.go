package main

import (
	"slices"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
)

func TestSkippedWorkersSkipStartupSkillReconciliation(t *testing.T) {
	t.Parallel()

	var requested []string
	environment := func(key string) string {
		requested = append(requested, key)
		if key == "TEAMHUB_SKIP_STARTUP_SKILL_RECONCILIATION" {
			return "1"
		}
		return ""
	}
	if got := skippedWorkers(environment); !slices.Equal(got, []app.Worker{app.SkillInstall, app.SkillPackageProbe}) {
		t.Fatalf("skippedWorkers(skip) = %v, want the Skill install and probe", got)
	}
	if len(requested) != 1 || requested[0] != "TEAMHUB_SKIP_STARTUP_SKILL_RECONCILIATION" {
		t.Fatalf("skippedWorkers requested %v, want [TEAMHUB_SKIP_STARTUP_SKILL_RECONCILIATION]", requested)
	}
	if got := skippedWorkers(func(string) string { return "" }); len(got) != 0 {
		t.Fatalf("skippedWorkers(default) = %v, want none", got)
	}
}
