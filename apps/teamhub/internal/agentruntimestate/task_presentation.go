package agentruntimestate

import (
	"context"
	"encoding/json"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Task inputs stay private. Only an exact participant Context may publish its
// separate public presentation in the Task's work Room.
func resolveTaskRuntimeStatusRoom(ctx context.Context, queries *store.Queries, owner contextRecord, sources []string) (string, bool, error) {
	if !taskPresentationSourcesMatch(owner, sources) {
		return "", false, nil
	}
	roomID, err := queries.GetAgentRuntimeTaskParticipantRoom(ctx, store.GetAgentRuntimeTaskParticipantRoomParams{
		TaskID: owner.TaskID.String, TenantID: owner.TenantID,
		AgentActorID: owner.AgentActorID, AgentManagementID: owner.AgentManagementID,
	})
	if isNoRows(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return roomID, true, nil
}

func taskPresentationSourcesMatch(owner contextRecord, sources []string) bool {
	return owner.ContextKind == "alter_ego" && owner.TaskID.Valid &&
		len(sources) == 1 && sources[0] == "meta:"+owner.AgentActorID+":"+owner.TaskID.String
}

// Preserve the validated event's identity and lifecycle. executeCommand still
// hashes the original request, including fields omitted from this projection.
func taskPublicPresentationEvent(event normalizedPresentationEvent) (normalizedPresentationEvent, error) {
	if event.EventType != "activity.started" && event.EventType != "activity.updated" && event.EventType != "activity.finished" {
		return event, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(event.Payload, &fields); err != nil {
		return normalizedPresentationEvent{}, err
	}
	delete(fields, "content")
	if event.EventType == "activity.updated" {
		fields["detail"] = json.RawMessage(`"Working"`)
	}
	payload, err := canonicalJSON(fields)
	if err != nil {
		return normalizedPresentationEvent{}, err
	}
	event.Payload = payload
	return event, nil
}
