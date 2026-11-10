package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) createRuntimeHumanInteraction(c *gin.Context) {
	var input teamhubinternal.CreateRuntimeHumanInteractionRequest
	if !a.decodeAgentRuntimeStateBody(c, &input) {
		return
	}
	var request struct {
		RequestID       string `json:"request_id"`
		Kind            string `json:"kind"`
		Prompt          string `json:"prompt"`
		AssigneeActorID string `json:"assignee_actor_id"`
		Form            struct {
			Type      string                       `json:"type"`
			Questions []typedcard.DecisionQuestion `json:"questions"`
		} `json:"form"`
	}
	encoded, err := json.Marshal(input.Request)
	if err != nil || json.Unmarshal(encoded, &request) != nil || request.RequestID == "" || len(request.RequestID) > 256 || len(encoded) > 128*1024 ||
		request.Form.Type != "questions" || request.Kind != "native_question" {
		a.writeError(c, 400, "INVALID_REQUEST", "Runtime interaction is invalid")
		return
	}
	owner, err := a.agentRuntimeState.GetContext(c.Request.Context(), input.ContextKey)
	if err != nil || owner.Ref.Kind != "meta" || owner.Ref.RoomID == "" || owner.TerminatedAt != nil {
		a.writeError(c, 403, "FORBIDDEN", "Runtime questions require an active Room Context")
		return
	}
	authority, err := a.agentRuntimeState.InteractionAuthority(c.Request.Context(), input.ContextKey, input.ExecutionRunRef)
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, 409, "CONFLICT", "Runtime request no longer belongs to an active execution")
		return
	}
	if err != nil {
		slog.ErrorContext(c.Request.Context(), "read Runtime interaction authority", "error", err)
		a.writeError(c, 503, "DEPENDENCY_UNAVAILABLE", "Runtime interaction authority is unavailable")
		return
	}
	if !authority.Running || authority.RuntimeType != "codex" {
		a.writeError(c, 409, "CONFLICT", "Runtime request no longer belongs to an active execution")
		return
	}
	if request.AssigneeActorID == "" {
		request.AssigneeActorID = authority.SponsorActorID
	}
	binding, _ := json.Marshal(map[string]any{"context_key": input.ContextKey, "execution_run_ref": input.ExecutionRunRef, "operation_id": input.OperationId, "request_id": request.RequestID, "kind": request.Kind})
	identity := sha256.Sum256([]byte(input.ContextKey + "\x00" + input.ExecutionRunRef + "\x00" + input.OperationId + "\x00" + request.RequestID))
	digest := sha256.Sum256(encoded)
	result, err := a.typedCards.CreateDecision(c.Request.Context(), owner.Ref.RoomID, owner.Ref.AgentID, "runtime-question-"+hex.EncodeToString(identity[:]), digest[:], typedcard.DecisionCommand{
		DeciderActorID: request.AssigneeActorID, RunID: input.ExecutionRunRef,
		Question: &typedcard.QuestionDecision{Prompt: request.Prompt, Questions: request.Form.Questions, Runtime: binding},
	})
	switch {
	case errors.Is(err, typedcard.ErrAssigneeNotMember):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "assignee_actor_id must name a human member of this Room")
		return
	case errors.Is(err, typedcard.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Runtime question breaks the question card rules")
		return
	case errors.Is(err, typedcard.ErrConflict), errors.Is(err, typedcard.ErrIdempotencyConflict), errors.Is(err, typedcard.ErrNotFound):
		a.writeError(c, http.StatusConflict, "CONFLICT", "Runtime interaction could not be created")
		return
	case err != nil:
		slog.ErrorContext(c.Request.Context(), "create Runtime interaction", "error", err)
		a.writeError(c, 503, "DEPENDENCY_UNAVAILABLE", "Runtime interaction is temporarily unavailable")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"interaction_id": result.DecisionID, "message_id": result.MessageID, "status": "pending"})
}
