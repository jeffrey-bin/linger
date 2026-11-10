package agentcreationapproval

import (
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestValidSourceInboxesAcceptsOnlyRoomSources(t *testing.T) {
	if !validSourceInboxes([]string{"room:room_origin"}) {
		t.Fatal("Room source was rejected")
	}
	for _, value := range []string{"task:task_1", "taskmeta:task_1", "meta:actor_a:task_1", "room:", "room:room/1"} {
		if validSourceInboxes([]string{value}) {
			t.Fatalf("non-Room source accepted: %q", value)
		}
	}
}

func TestValidateCreationSegmentsRejectsNonCreationKinds(t *testing.T) {
	card := []messagecreation.Segment{{
		Type: "document", Content: "report.md", DocumentID: "document_report", Presentation: "card",
	}}
	if validCreationSegments(card) {
		t.Fatal("Document segment was accepted by Creation message validation")
	}
}

func TestValidateRoomPairArtifacts(t *testing.T) {
	roomPair := func(callerArtifacts, effectiveArtifacts []string) (RoomCallerInput, RoomEffectivePayload) {
		segments := []messagecreation.Segment{{Type: "text", Content: "Start here"}}
		return RoomCallerInput{
				Name: "Room", MemberIDs: []string{"actor_agent"}, Artifacts: callerArtifacts,
				InitialMessageSegments: segments,
			}, RoomEffectivePayload{
				Name: "Room", MemberIDs: []string{"actor_agent"}, Artifacts: effectiveArtifacts,
				InitialMessageSegments: segments,
			}
	}

	for _, testCase := range []struct {
		name      string
		artifacts []string
		wantValid bool
	}{
		{name: "omitted", artifacts: nil, wantValid: true},
		{name: "ordered documents", artifacts: []string{"document_brief", "document_evidence"}, wantValid: true},
		{name: "present but empty", artifacts: []string{}, wantValid: false},
		{name: "duplicate", artifacts: []string{"document_brief", "document_brief"}, wantValid: false},
		{name: "too many", artifacts: []string{"document_1", "document_2", "document_3", "document_4", "document_5", "document_6"}, wantValid: false},
		{name: "invalid identifier", artifacts: []string{"document/brief"}, wantValid: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			caller, effective := roomPair(testCase.artifacts, testCase.artifacts)
			err := validateRoomPair(caller, effective)
			if testCase.wantValid && err != nil {
				t.Fatalf("valid Room artifacts rejected: %v", err)
			}
			if !testCase.wantValid && !errors.Is(err, ErrInvalid) {
				t.Fatalf("error=%v want ErrInvalid", err)
			}
		})
	}

	t.Run("presence mismatch", func(t *testing.T) {
		caller, effective := roomPair(nil, []string{"document_brief"})
		if err := validateRoomPair(caller, effective); !errors.Is(err, ErrInvalid) {
			t.Fatalf("error=%v want ErrInvalid", err)
		}
	})

	t.Run("order mismatch", func(t *testing.T) {
		caller, effective := roomPair(
			[]string{"document_brief", "document_evidence"},
			[]string{"document_evidence", "document_brief"},
		)
		if err := validateRoomPair(caller, effective); !errors.Is(err, ErrInvalid) {
			t.Fatalf("error=%v want ErrInvalid", err)
		}
	})
}

func TestValidateReferencesRestrictsRoomMessageToFutureRoomMembers(t *testing.T) {
	members := map[string]store.ResolveAgentCreationActorsRow{
		"actor_member": {ID: "actor_member", Kind: "human"},
	}
	extras := map[string]string{
		"actor_requester": "agent",
		"actor_approver":  "user",
	}
	allowed := []messagecreation.Segment{
		{Type: "reference", Target: "actor_member", TargetType: "user"},
		{Type: "reference", Target: "actor_requester", TargetType: "agent"},
		{Type: "reference", Target: "actor_approver", TargetType: "user"},
	}
	if err := validateReferences(allowed, members, extras); err != nil {
		t.Fatalf("allowed future Room references rejected: %v", err)
	}
	outside := []messagecreation.Segment{
		{Type: "reference", Target: "actor_outside", TargetType: "user"},
	}
	if err := validateReferences(outside, members, extras); !errors.Is(err, ErrConflict) {
		t.Fatalf("outside reference error=%v want ErrConflict", err)
	}
}
