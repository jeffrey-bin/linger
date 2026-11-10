package agentruntimestate

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestOutputWithoutInternalRunNeedsNoRuntimeState(t *testing.T) {
	result, err := RecordPresentationOutput(context.Background(), nil, PresentationOutput{
		TenantID: "tenant_one", AgentActorID: "actor_one", RoomID: "room_one",
		OutputID: "message_one", OutputKind: "message", Surface: "room_timeline", MessageID: "message_one",
	})
	if err != nil || result.Recorded {
		t.Fatalf("independent business output must not fabricate a runtime event: result=%+v err=%v", result, err)
	}
}

func TestOutputReplayMustKeepContinuationDeclaration(t *testing.T) {
	input := PresentationOutput{
		LocalRunID: "run_one", TenantID: "tenant_one", AgentActorID: "actor_one", RoomID: "room_one",
		InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64),
		OutputID:     "message_one", OutputKind: "message", Surface: "room_timeline", MessageID: "message_one",
		Continues: true,
	}
	payload, err := json.Marshal(outputCreatedEvent{
		Type: "presentation.output_created", OutputID: input.OutputID, OutputKind: input.OutputKind,
		Surface: input.Surface, Continues: input.Continues,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"continues":true`) {
		t.Fatalf("continuing output lost its declaration: %s", payload)
	}
	row := store.AgentRuntimeStatusEvent{
		Payload: payload, MessageID: optionalText(input.MessageID), InvocationID: optionalText(input.InvocationID),
	}
	if !sameOutput(row, input) {
		t.Fatal("identical continuing output replay was treated as a conflict")
	}
	input.Continues = false
	if sameOutput(row, input) {
		t.Fatal("output replay with a different continuation declaration was accepted")
	}
	final, err := json.Marshal(outputCreatedEvent{
		Type: "presentation.output_created", OutputID: input.OutputID, OutputKind: input.OutputKind, Surface: input.Surface,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(final), "continues") {
		t.Fatalf("ordinary output must keep its existing payload: %s", final)
	}
}
