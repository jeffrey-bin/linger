package document

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type documentCommentRunInput struct {
	TenantID          string
	RoomID            string
	DocumentID        string
	CommentID         string
	CommentVersion    int64
	AgentActorID      string
	AgentManagementID string
	Notification      string
	CommentsMarkdown  string
}

// enqueueDocumentCommentRun admits one trusted Document notification as one
// serialized Local Run and returns its ID. The input names the triggering
// comment and carries the text the Agent was mentioned with; the comment's
// edit number and optional Room binding gate when the Run may start.
// Structured Human mention evidence already proves that
// this notification is targeted, so it never enters selection or steer.
func enqueueDocumentCommentRun(
	ctx context.Context,
	tx pgx.Tx,
	input documentCommentRunInput,
) (string, error) {
	if tx == nil || strings.TrimSpace(input.TenantID) == "" ||
		strings.TrimSpace(input.DocumentID) == "" || strings.TrimSpace(input.CommentID) == "" ||
		input.CommentVersion < 1 || strings.TrimSpace(input.AgentActorID) == "" ||
		strings.TrimSpace(input.AgentManagementID) == "" || strings.TrimSpace(input.Notification) == "" ||
		strings.TrimSpace(input.CommentsMarkdown) == "" || len(input.CommentsMarkdown) > maxDocumentCommentsMarkdownBytes {
		return "", errors.New("invalid Document Comment Local Run input")
	}
	encodedKey, err := json.Marshal([]string{"document", input.AgentManagementID, input.DocumentID})
	if err != nil {
		return "", err
	}
	contextKey := string(encodedKey)
	queries := store.New(tx)
	if _, err := queries.InsertAgentExecutionContext(ctx, store.InsertAgentExecutionContextParams{
		ContextKey: contextKey, ContextKind: "document", TaskID: pgtype.Text{}, RoomID: pgtype.Text{},
		DocumentID:      pgtype.Text{String: input.DocumentID, Valid: true},
		TargetResidency: "suspended", AgentManagementID: input.AgentManagementID,
	}); err != nil {
		return "", err
	}
	contextRow, err := queries.LockAgentExecutionContext(ctx, contextKey)
	if err != nil {
		return "", err
	}
	if contextRow.TenantID != input.TenantID || contextRow.AgentActorID != input.AgentActorID ||
		contextRow.AgentManagementID != input.AgentManagementID || contextRow.ContextKind != "document" ||
		contextRow.TaskID.Valid || contextRow.RoomID.Valid || !contextRow.DocumentID.Valid ||
		contextRow.DocumentID.String != input.DocumentID {
		return "", errors.New("Document Context identity conflicts with mention")
	}

	runID := newInputID("local-run-")
	runtimeInputID := newInputID("document-comment-input-")
	if _, err := queries.CreateAgentLocalRun(ctx, store.CreateAgentLocalRunParams{
		RunID: runID, ContextKey: contextKey,
	}); err != nil {
		return "", err
	}

	payload, err := json.Marshal(map[string]any{
		"messageId":                runtimeInputID,
		"documentCommentVersion":   input.CommentVersion,
		"documentCommentRoomId":    input.RoomID,
		"rawMessage":               input.Notification,
		"segments":                 []map[string]string{{"type": "text", "content": input.Notification}},
		"sourceInboxIds":           []string{"document:" + input.DocumentID},
		"documentCommentsMarkdown": input.CommentsMarkdown,
	})
	if err != nil {
		return "", err
	}
	payloadHash := sha256.Sum256(payload)
	selection, err := json.Marshal(map[string]any{
		"selected": "trusted_inbox_notification", "effective": "enqueue",
	})
	if err != nil {
		return "", err
	}
	sequence, err := queries.InsertAgentRuntimeInput(ctx, store.InsertAgentRuntimeInputParams{
		ContextKey: contextKey, InputID: runtimeInputID,
		Payload: payload, PayloadHash: payloadHash[:], SourceKind: "inbox",
		SourceMessageID: pgtype.Text{String: input.CommentID, Valid: true},
		SourceInboxID:   pgtype.Text{String: "document:" + input.DocumentID, Valid: true},
		Status:          "handled", SelectionResult: selection,
		LocalRunID: pgtype.Text{String: runID, Valid: true},
	})
	if err != nil {
		return "", err
	}
	if err := queries.InsertAgentLocalRunInput(ctx, store.InsertAgentLocalRunInputParams{
		RunID: runID, ContextKey: contextKey, InputID: runtimeInputID,
		Relation: "initial", Ordinal: 0,
	}); err != nil {
		return "", err
	}
	if err := queries.RecordAgentDocumentCommentContextInput(ctx, store.RecordAgentDocumentCommentContextInputParams{
		InputSequence: sequence, ContextKey: contextKey,
	}); err != nil {
		return "", err
	}
	return runID, nil
}
