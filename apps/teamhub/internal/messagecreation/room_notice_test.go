package messagecreation

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	nova   = store.Actor{ID: "actor_nova", TenantID: "tenant_one", Kind: "agent", DisplayName: "Nova"}
	review = store.Actor{ID: "actor_review", TenantID: "tenant_one", Kind: "agent", DisplayName: "Release Reviewer"}
	leo    = store.Actor{ID: "actor_leo", TenantID: "tenant_one", Kind: "human", DisplayName: "Leo"}
)

func TestNoticesCarryThePublicShapeAndAPlainLine(t *testing.T) {
	for _, test := range []struct {
		name   string
		author store.Actor
		notice Notice
		json   string
		text   string
	}{
		{
			"created here", nova, AgentCreated(review, nil),
			`{"type":"agent_created","agent":{"id":"actor_review","tenant_id":"tenant_one","kind":"agent","display_name":"Release Reviewer"}}`,
			"Nova created Release Reviewer and added it to this Room.",
		},
		{
			"created after approval", nova, AgentCreated(review, &leo),
			`{"type":"agent_created","agent":{"id":"actor_review","tenant_id":"tenant_one","kind":"agent","display_name":"Release Reviewer"},"approved_by":{"id":"actor_leo","tenant_id":"tenant_one","kind":"human","display_name":"Leo"}}`,
			"Nova created Release Reviewer after Leo approved it.",
		},
		{
			"member added", leo, MemberAdded(nova),
			`{"type":"member_added","member":{"id":"actor_nova","tenant_id":"tenant_one","kind":"agent","display_name":"Nova"}}`,
			"Leo added Nova to this Room.",
		},
		{
			"self initialized", review, AgentProfileChanged(review, true, []FieldChange{{Field: "name", Before: "New Agent", After: "Release Reviewer"}}, true),
			`{"type":"agent_profile_changed","agent":{"id":"actor_review","tenant_id":"tenant_one","kind":"agent","display_name":"Release Reviewer"},"initialized":true,"changes":[{"field":"name","before":"New Agent","after":"Release Reviewer"}],"instructions_changed":true}`,
			"New Agent set up its identity as Release Reviewer.",
		},
		{
			"initialized by another Agent", nova, AgentProfileChanged(review, true, []FieldChange{{Field: "name", Before: "New Agent", After: "Release Reviewer"}}, true),
			"", "Nova set up New Agent as Release Reviewer.",
		},
		{
			"updated", nova, AgentProfileChanged(review, false, []FieldChange{{Field: "description", Before: "Checks lists.", After: "Checks lists and tests."}}, true),
			`{"type":"agent_profile_changed","agent":{"id":"actor_review","tenant_id":"tenant_one","kind":"agent","display_name":"Release Reviewer"},"initialized":false,"changes":[{"field":"description","before":"Checks lists.","after":"Checks lists and tests."}],"instructions_changed":true}`,
			"Nova updated Release Reviewer: description, instructions.",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.json != "" {
				encoded, err := json.Marshal(test.notice)
				if err != nil || string(encoded) != test.json {
					t.Fatalf("json=%s err=%v", encoded, err)
				}
			}
			if text := test.notice.Text(test.author); text != test.text {
				t.Fatalf("text=%q", text)
			}
		})
	}
}

func TestAProfileNoticeNeverCarriesInstructionText(t *testing.T) {
	notice := AgentProfileChanged(review, false, nil, true)
	encoded, err := json.Marshal(notice)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "prompt") || !strings.Contains(string(encoded), `"changes":[]`) {
		t.Fatalf("notice=%s", encoded)
	}
	if notice.Empty() || !AgentProfileChanged(review, false, nil, false).Empty() {
		t.Fatal("only a change with nothing changed is empty")
	}
}
