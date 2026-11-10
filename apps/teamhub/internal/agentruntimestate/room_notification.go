package agentruntimestate

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// validateRoomRuntimeInput lets a trusted turn name Room Messages only when
// each still reaches this Context: none canceled or routed away. The caller
// authorized the Input's Inboxes.
func validateRoomRuntimeInput(ctx context.Context, db store.DBTX, owner contextRecord, input RuntimeInput) error {
	var payload struct {
		IDs []string `json:"invocationMessageIds"`
	}
	if err := json.Unmarshal(input.Payload, &payload); err != nil {
		return ErrInvalid
	}
	if len(payload.IDs) == 0 {
		if input.SourceKind == "inbox" {
			return ErrInvalid
		}
		return nil
	}
	seen := make(map[string]bool, len(payload.IDs))
	for _, id := range payload.IDs {
		if strings.TrimSpace(id) == "" || seen[id] {
			return ErrInvalid
		}
		seen[id] = true
	}
	queries := store.New(db)
	roomID := owner.RoomID.String
	if input.SourceInboxID != "" {
		inbox, err := queries.GetAgentContextInbox(ctx, store.GetAgentContextInboxParams{ContextKey: owner.ContextKey, InboxID: input.SourceInboxID})
		if isNoRows(err) {
			return ErrInboxNotAuthorized
		}
		if err != nil {
			return err
		}
		// A private Task stream has no Room Message to check.
		if inbox.CursorEncoding != "room_event_v1" {
			return nil
		}
		roomID = inbox.RoomID
	}
	if roomID == "" {
		return nil
	}
	rows, err := queries.ListRoomMessageDispositions(ctx, store.ListRoomMessageDispositionsParams{
		TenantID: owner.TenantID, RoomID: roomID, AgentActorID: owner.AgentActorID, ContextKey: owner.ContextKey,
		InboxID: input.SourceInboxID, MessageIds: payload.IDs,
	})
	if err != nil {
		return err
	}
	if len(rows) != len(payload.IDs) {
		return ErrInvalid
	}
	for _, row := range rows {
		if row.Disposition == "ignore" {
			return ErrInvalid
		}
	}
	return nil
}
