package agentruntimestate

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestTaskPresentationRequiresExactPrivateTaskSource(t *testing.T) {
	owner := contextRecord{ContextKind: "alter_ego", AgentActorID: "agent-a", TaskID: pgtype.Text{String: "task-a", Valid: true}}
	for _, sources := range [][]string{nil, {"meta:agent-b:task-a"}, {"meta:agent-a:task-b"}, {"meta:agent-a"}, {"meta:agent-a:task-a", "room:public"}} {
		if taskPresentationSourcesMatch(owner, sources) {
			t.Fatalf("accepted mismatched sources %v", sources)
		}
	}
	if !taskPresentationSourcesMatch(owner, []string{"meta:agent-a:task-a"}) {
		t.Fatal("rejected exact Task participant source")
	}
	owner.ContextKind = "meta"
	if taskPresentationSourcesMatch(owner, []string{"meta:agent-a:task-a"}) {
		t.Fatal("opened global Meta activity")
	}
}

func TestTaskPresentationOmitsPrivateContentWithoutChangingLifecycle(t *testing.T) {
	for _, raw := range []string{
		`{"type":"activity.started","activity_id":"tool-1","kind":"command","title":"Checking workspace","content":[{"format":"code","content":"private command"}]}`,
		`{"type":"activity.updated","activity_id":"tool-1","detail":"private detail"}`,
		`{"type":"activity.finished","activity_id":"tool-1","outcome":"failed","content":[{"format":"text","content":"private failure"}]}`,
	} {
		event, err := normalizeOfferedPresentationEvent(json.RawMessage(raw))
		if err != nil {
			t.Fatal(err)
		}
		original := string(event.Payload)
		public, err := taskPublicPresentationEvent(event)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(public.Payload), "private") || strings.Contains(string(public.Payload), `"content"`) {
			t.Fatalf("private payload: %s", public.Payload)
		}
		if string(event.Payload) != original {
			t.Fatal("filter mutated original request")
		}
		checked, err := normalizeOfferedPresentationEvent(public.Payload)
		if err != nil || checked.ActivityID != event.ActivityID || checked.EventType != event.EventType || checked.Outcome != event.Outcome {
			t.Fatalf("invalid public lifecycle: %+v %v", public, err)
		}
	}
}
