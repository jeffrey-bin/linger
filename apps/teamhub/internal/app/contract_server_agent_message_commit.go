package app

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// commitAgentMessage stages transport bytes without publishing business state;
// Send then commits the resources, one message, events and receipt together.
func (a *App) commitAgentMessage(c *gin.Context) {
	token, ok := strictAgentBearer(c)
	if !ok {
		a.writeAgentSendMessageError(c, agentauth.ErrCredentialInvalid)
		return
	}
	reader, err := agentFileToolMultipartReader(c, (512<<20)+(8<<20))
	if err != nil {
		a.writeInvalidAgentSendMessage(c)
		return
	}
	part, err := reader.NextPart()
	if err != nil || part.FormName() != "metadata" || part.FileName() != "" {
		if part != nil {
			_ = part.Close()
		}
		a.writeInvalidAgentSendMessage(c)
		return
	}
	metadata, err := io.ReadAll(io.LimitReader(part, (5<<20)+1))
	_ = part.Close()
	if err != nil || len(metadata) > 5<<20 {
		a.writeInvalidAgentSendMessage(c)
		return
	}
	var envelope struct {
		InvocationID    string                             `json:"invocation_id"`
		InboxID         string                             `json:"inbox_id"`
		SourceMessageID string                             `json:"source_message_id,omitempty"`
		Continues       bool                               `json:"continues,omitempty"`
		CardTitle       string                             `json:"card_title,omitempty"`
		CardKind        string                             `json:"card_kind,omitempty"`
		Segments        []agentsendmessage.PreparedSegment `json:"segments"`
		Uploads         []agentsendmessage.PreparedUpload  `json:"uploads"`
	}
	var requiredFields map[string]json.RawMessage
	// Malformed metadata leaves requiredFields nil and is rejected by the checks just below.
	_ = json.Unmarshal(metadata, &requiredFields)
	if key := agentExecutionClaim(requiredFields); key != "" {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Agent commands cannot supply execution authority: "+key)
		return
	}
	if requiredFields["invocation_id"] == nil || requiredFields["inbox_id"] == nil || requiredFields["segments"] == nil || requiredFields["uploads"] == nil || decodeStrictJSONBytes(metadata, &envelope) != nil {
		a.writeInvalidAgentSendMessage(c)
		return
	}
	input := agentsendmessage.Input{SourceInboxIDs: []string{}, InvocationID: envelope.InvocationID, InboxID: envelope.InboxID, SourceMessageID: envelope.SourceMessageID, Continues: envelope.Continues, CardTitle: envelope.CardTitle, CardKind: envelope.CardKind, Atomic: &agentsendmessage.AtomicInput{Segments: envelope.Segments, Uploads: envelope.Uploads}}
	if agentsendmessage.ValidateAtomicInput(input) != nil {
		a.writeInvalidAgentSendMessage(c)
		return
	}
	// Refuse unauthorized/unsupported contexts before accepting resource bytes.
	if _, err := a.agentAuth.Authorize(c.Request.Context(), token, "send_message"); a.writeAgentSendMessageError(c, err) {
		return
	}
	transferred := false
	defer func() {
		if !transferred {
			for _, u := range input.Atomic.Uploads {
				if u.ObjectKey != "" {
					_ = artifactstore.DeleteDetached(c.Request.Context(), a.artifacts, u.ObjectKey)
				}
			}
		}
	}()
	for index, upload := range input.Atomic.Uploads {
		file, err := reader.NextPart()
		if err != nil || file.FormName() != "file" || file.FileName() != upload.UploadID {
			if file != nil {
				_ = file.Close()
			}
			a.writeInvalidAgentSendMessage(c)
			return
		}
		object, err := a.artifacts.Put(c.Request.Context(), io.LimitReader(file, upload.SizeBytes+1))
		_ = file.Close()
		if err != nil {
			a.writeAgentMessageCommitError(c, err)
			return
		}
		input.Atomic.Uploads[index].ObjectKey = object.Key
		if object.Size != upload.SizeBytes || hex.EncodeToString(object.SHA256[:]) != upload.SHA256 {
			a.writeInvalidAgentSendMessage(c)
			return
		}
	}
	extra, err := reader.NextPart()
	if extra != nil {
		_ = extra.Close()
	}
	if !errors.Is(err, io.EOF) {
		a.writeInvalidAgentSendMessage(c)
		return
	}
	transferred = true
	result, err := a.agentSendMessages.Send(c.Request.Context(), token, input)
	if a.writeAgentMessageCommitError(c, err) {
		return
	}
	a.recordAgentMessageCommitTiming(c, envelope.InvocationID, result)
	kind, id := "room", result.InboxID
	if prefix, remainder, found := strings.Cut(result.InboxID, ":"); found {
		kind, id = prefix, remainder
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, agentMessageReceipt(gin.H{"accepted": result.Accepted, "target": gin.H{"type": kind, "id": id}, "inbox_id": result.InboxID, "message_id": result.MessageID, "resources": result.Resources}, result.Replay, "The original message and resources are already persisted."))
}

func (a *App) writeAgentMessageCommitError(c *gin.Context, err error) bool {
	// Resource publication retains the existing file-domain errors even though
	// its transaction is now committed with the message.
	switch {
	case errors.Is(err, document.ErrAgentTreePathConflict), errors.Is(err, document.ErrFilePublicationForbidden),
		errors.Is(err, document.ErrVersionConflict), errors.Is(err, document.ErrIdempotencyConflict),
		errors.Is(err, document.ErrInvalidInput), errors.Is(err, document.ErrNotFound), errors.Is(err, document.ErrConflict),
		errors.Is(err, document.ErrRecoveryBudgetExceeded), errors.Is(err, artifactstore.ErrTooLarge):
		return a.writeAgentCLIFileError(c, err)
	default:
		return a.writeAgentSendMessageError(c, err)
	}
}

// Send has returned successfully: never label a replay as a new DB commit.
func (a *App) recordAgentMessageCommitTiming(c *gin.Context, invocationID string, result agentsendmessage.Result) {
	code := "committed"
	if result.Replay {
		code = "replayed"
	}
	a.logger.InfoContext(c.Request.Context(), "room.message_committed",
		"invocation_id", invocationID, "inbox_id", result.InboxID,
		"message_id", result.MessageID, "observed_at_unix_ms", time.Now().UnixMilli(), "result", code)
}
