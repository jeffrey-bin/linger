package teammd

import (
	"strings"
	"testing"
)

const validDocument = `---
collaborate_pattern: fan-out-and-synthesize
---

## Task Goal

Summarize the competitive landscape for workflow platforms.

## Orchestrator

- Coordinator
  - ID: actor_agent_01

## Team Member

- Researcher
  - ID: actor_agent_02
  - Role: Collect raw vendor material.
  - Report to: Coordinator
  - Receive from: Coordinator

- Synthesizer
  - ID: actor_agent_03
  - Role: Merge findings into one brief.
  - Report to: Coordinator
  - Receive from: Researcher
`

func codes(issues []Issue) []string {
	values := make([]string, 0, len(issues))
	for _, issue := range issues {
		values = append(values, issue.Code)
	}
	return values
}

func hasCode(issues []Issue, code string) bool {
	for _, issue := range issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}

func TestParseValidDocument(t *testing.T) {
	t.Parallel()
	document, issues := Parse(validDocument)
	if len(issues) != 0 {
		t.Fatalf("Parse(valid) issues=%v", codes(issues))
	}
	if document.Pattern != PatternFanOutAndSynthesize {
		t.Fatalf("pattern=%q", document.Pattern)
	}
	if document.TaskGoal != "Summarize the competitive landscape for workflow platforms." {
		t.Fatalf("task goal=%q", document.TaskGoal)
	}
	if document.Orchestrator.Name != "Coordinator" || document.Orchestrator.ActorID != "actor_agent_01" {
		t.Fatalf("orchestrator=%+v", document.Orchestrator)
	}
	if len(document.Members) != 2 {
		t.Fatalf("members=%d", len(document.Members))
	}
	synthesizer := document.Members[1]
	if synthesizer.Name != "Synthesizer" || synthesizer.ActorID != "actor_agent_03" {
		t.Fatalf("second member=%+v", synthesizer)
	}
	if synthesizer.Role != "Merge findings into one brief." {
		t.Fatalf("second member role=%q", synthesizer.Role)
	}
	if len(synthesizer.ReceiveFrom) != 1 || synthesizer.ReceiveFrom[0] != "Researcher" {
		t.Fatalf("second member receive from=%v", synthesizer.ReceiveFrom)
	}
	want := []string{"actor_agent_01", "actor_agent_02", "actor_agent_03"}
	got := document.ActorIDs()
	if len(got) != len(want) {
		t.Fatalf("ActorIDs()=%v", got)
	}
	for index, actorID := range want {
		if got[index] != actorID {
			t.Fatalf("ActorIDs()=%v want %v", got, want)
		}
	}
}

func TestParseRejectsStructuralProblems(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name    string
		content string
		code    string
	}{
		{
			name:    "no frontmatter",
			content: "## Task Goal\n\nDo the thing.\n",
			code:    CodeFrontmatterMissing,
		},
		{
			name:    "unterminated frontmatter",
			content: "---\ncollaborate_pattern: tournament\n\n## Task Goal\n",
			code:    CodeFrontmatterMissing,
		},
		{
			name:    "misspelled pattern from the original draft",
			content: strings.Replace(validDocument, "fan-out-and-synthesize", "classifiy-and-act", 1), //nolint:misspell // deliberately misspelled, undeclared Pattern name
			code:    CodePatternInvalid,
		},
		{
			name:    "spaced pattern from the original draft",
			content: strings.Replace(validDocument, "fan-out-and-synthesize", "adversarial verification", 1),
			code:    CodePatternInvalid,
		},
		{
			name:    "spaced frontmatter key from the original draft",
			content: strings.Replace(validDocument, "collaborate_pattern:", "collaborate pattern:", 1),
			code:    CodePatternMissing,
		},
		{
			name:    "empty task goal",
			content: strings.Replace(validDocument, "Summarize the competitive landscape for workflow platforms.\n", "", 1),
			code:    CodeTaskGoalMissing,
		},
		{
			name:    "missing section",
			content: strings.Replace(validDocument, "## Team Member", "## Collaborators", 1),
			code:    CodeSectionMissing,
		},
		{
			name:    "unknown section",
			content: validDocument + "\n## Notes\n\nextra\n",
			code:    CodeSectionUnknown,
		},
		{
			name:    "duplicate section",
			content: validDocument + "\n## Task Goal\n\nagain\n",
			code:    CodeSectionDuplicated,
		},
		{
			name:    "two orchestrators",
			content: strings.Replace(validDocument, "- Coordinator\n  - ID: actor_agent_01\n", "- Coordinator\n  - ID: actor_agent_01\n- Deputy\n  - ID: actor_agent_09\n", 1),
			code:    CodeOrchestratorInvalid,
		},
		{
			name:    "orchestrator without id",
			content: strings.Replace(validDocument, "- Coordinator\n  - ID: actor_agent_01\n", "- Coordinator\n", 1),
			code:    CodeActorIDMissing,
		},
		{
			name:    "duplicate member name",
			content: strings.Replace(validDocument, "- Synthesizer\n", "- Researcher\n", 1),
			code:    CodeNameDuplicated,
		},
		{
			name:    "member reuses the orchestrator id",
			content: strings.Replace(validDocument, "  - ID: actor_agent_03", "  - ID: actor_agent_01", 1),
			code:    CodeActorIDDuplicated,
		},
		{
			name:    "unknown relationship target",
			content: strings.Replace(validDocument, "  - Report to: Coordinator\n  - Receive from: Researcher", "  - Report to: Nobody\n  - Receive from: Researcher", 1),
			code:    CodeReferenceUnknown,
		},
		{
			name:    "unknown attribute",
			content: strings.Replace(validDocument, "  - Role: Merge findings into one brief.", "  - Owner: someone", 1),
			code:    CodeAttributeUnknown,
		},
		{
			name:    "duplicate attribute",
			content: strings.Replace(validDocument, "  - Role: Merge findings into one brief.", "  - ID: actor_agent_77", 1),
			code:    CodeAttributeDuplicated,
		},
		{
			name:    "content too large",
			content: strings.Replace(validDocument, "Summarize", strings.Repeat("x", MaxContentBytes), 1),
			code:    CodeContentTooLarge,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, issues := Parse(test.content)
			if !hasCode(issues, test.code) {
				t.Fatalf("Parse() codes=%v want %q", codes(issues), test.code)
			}
		})
	}
}

func TestParseAcceptsRelationshipSpellings(t *testing.T) {
	t.Parallel()
	content := `---
collaborate_pattern: loop-until-done
---

## Task Goal

Iterate until the draft passes review.

## Orchestrator

- Lead
  - ID: actor_agent_01

## Team Member

- Writer
  - ID: actor_agent_02
  - report_to: Lead
  - Receive From: none

- Reviewer
  - ID: actor_agent_03
  - Report to: Lead, Writer
  - Receive from: -
`
	document, issues := Parse(content)
	if len(issues) != 0 {
		t.Fatalf("Parse() issues=%v", codes(issues))
	}
	writer := document.Members[0]
	if len(writer.ReportTo) != 1 || writer.ReportTo[0] != "Lead" {
		t.Fatalf("report_to=%v", writer.ReportTo)
	}
	if len(writer.ReceiveFrom) != 0 {
		t.Fatalf("none must clear the relationship, got %v", writer.ReceiveFrom)
	}
	reviewer := document.Members[1]
	if len(reviewer.ReportTo) != 2 {
		t.Fatalf("comma separated report to=%v", reviewer.ReportTo)
	}
	if len(reviewer.ReceiveFrom) != 0 {
		t.Fatalf("- must clear the relationship, got %v", reviewer.ReceiveFrom)
	}
}

func TestValidateRequiresActiveRoomMembership(t *testing.T) {
	t.Parallel()
	document, issues := Parse(validDocument)
	if len(issues) != 0 {
		t.Fatalf("Parse() issues=%v", codes(issues))
	}
	if remaining := Validate(document, []string{"actor_agent_01", "actor_agent_02", "actor_agent_03"}); len(remaining) != 0 {
		t.Fatalf("Validate(full roster) issues=%v", codes(remaining))
	}
	missingMember := Validate(document, []string{"actor_agent_01", "actor_agent_02"})
	if len(missingMember) != 1 || missingMember[0].Code != CodeActorNotRoomMember {
		t.Fatalf("Validate(partial roster) issues=%v", missingMember)
	}
	if missingMember[0].Path != "members[1].id" {
		t.Fatalf("issue path=%q", missingMember[0].Path)
	}
	missingOrchestrator := Validate(document, []string{"actor_agent_02", "actor_agent_03"})
	if len(missingOrchestrator) != 1 || missingOrchestrator[0].Path != "orchestrator.id" {
		t.Fatalf("Validate(no orchestrator) issues=%v", missingOrchestrator)
	}
}

func TestValidPattern(t *testing.T) {
	t.Parallel()
	for _, pattern := range Patterns {
		if !ValidPattern(string(pattern)) {
			t.Fatalf("ValidPattern(%q) must accept a declared pattern", pattern)
		}
	}
	for _, value := range []string{"", "classifiy-and-act", "adversarial verification", "Tournament", "fan out and synthesize"} { //nolint:misspell // deliberately misspelled, undeclared Pattern name
		if ValidPattern(value) {
			t.Fatalf("ValidPattern(%q) must reject an undeclared pattern", value)
		}
	}
}
