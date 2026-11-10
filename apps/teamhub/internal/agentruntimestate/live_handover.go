package agentruntimestate

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Attach handover data to the first claimed durable input that resumes Meta. This is a
// database read, never a model summary or a walk of the user's Computer.
func attachLiveHandover(ctx context.Context, queries *store.Queries, owner contextRecord, input RuntimeInput) (RuntimeInput, error) {
	if owner.ContextKind != "meta" {
		return input, nil
	}
	session, err := queries.GetVoiceLiveHandoverForContext(ctx, owner.ContextKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return input, nil
	}
	if err != nil {
		return input, err
	}
	messages, err := queries.ListVoiceLiveHandoverMessages(ctx, session.RoomID)
	if err != nil {
		return input, err
	}
	slices.Reverse(messages)
	tasks, err := queries.ListVoiceLiveHandoverTasks(ctx, store.ListVoiceLiveHandoverTasksParams{RoomID: session.RoomID, OwnerActorID: session.CreatedByActorID})
	if err != nil {
		return input, err
	}
	operations, err := queries.ListVoiceLiveUncertainOperations(ctx, session.ID)
	if err != nil {
		return input, err
	}
	var payload map[string]json.RawMessage
	if err = json.Unmarshal(input.Payload, &payload); err != nil {
		return input, err
	}
	payload["liveHandover"], err = json.Marshal(map[string]any{"voice_session_id": session.ID, "room_id": session.RoomID, "messages": messages, "tasks": tasks, "unconfirmed_operations": operations})
	if err != nil {
		return input, err
	}
	input.Payload, err = json.Marshal(payload)
	if err != nil {
		return input, err
	}
	canonical, err := canonicalJSON(input.Payload)
	if err != nil {
		return input, err
	}
	digest := sha256.Sum256(canonical)
	if err := queries.AttachVoiceLiveHandoverToInput(ctx, store.AttachVoiceLiveHandoverToInputParams{ContextKey: owner.ContextKey, InputID: input.InputID, Payload: canonical, PayloadHash: digest[:]}); err != nil {
		return input, err
	}
	input.Payload = canonical
	err = queries.RecordVoiceLiveHandoverReceipt(ctx, store.RecordVoiceLiveHandoverReceiptParams{ContextKey: owner.ContextKey, VoiceSessionID: session.ID, InputID: input.InputID})
	return input, err
}
