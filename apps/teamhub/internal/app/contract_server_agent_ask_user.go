package app

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// askAgentUser posts a question card for the Agent's Sponsor in its Context
// Room, or in a Thread of it, and returns at once. The card carries no Run: its answer reaches the
// Agent as the hidden handoff Message that mentions it, like any other card
// result.
func (a *App) askAgentUser(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request api.AgentAskUserRequest
	if !a.decodeAgentRequest(c, &request) {
		return
	}
	if !agentregistry.AgentInvocationPattern.MatchString(request.InvocationId) {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidRequest, "Question request is invalid")
		return
	}
	ctx := c.Request.Context()
	auth, err := a.agentAuth.Authorize(ctx, token, "ask_user")
	if a.writeAgentAuthError(c, "ask user", err) {
		return
	}
	questions, ok := askUserQuestions(request.Questions)
	if !ok {
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidRequest, "The question breaks the question card rules")
		return
	}
	roomID := auth.RoomID
	if request.ThreadId != nil {
		// A Thread of the Context Room holds the card, so the answer comes
		// back into that Thread.
		thread, err := a.collaboration.AgentThreadRoom(ctx, auth.TenantID, auth.AgentActorID, *request.ThreadId)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && !agentauth.AllowsRoomTarget(auth, thread.ParentRoomID) {
			a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "That Thread isn't in this chat")
			return
		}
		if err != nil {
			a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Questions are temporarily unavailable")
			return
		}
		roomID = thread.RoomID
	}
	encoded, _ := json.Marshal(request.Questions)
	hash := sha256.Sum256(fmt.Appendf(nil, "%s\x00%s\x00%s", roomID, request.Title, encoded))
	result, err := a.typedCards.CreateDecision(ctx, roomID, auth.AgentID, "ask-user-"+request.InvocationId, hash[:], typedcard.DecisionCommand{
		Principal: auth.Principal, DeciderActorID: auth.SponsorActorID,
		Question: &typedcard.QuestionDecision{Prompt: request.Title, Questions: questions},
	})
	switch {
	case errors.Is(err, typedcard.ErrAssigneeNotMember):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Your Sponsor isn't in this chat, so there is nobody to ask here; ask in your reply instead")
		return
	case errors.Is(err, typedcard.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, api.AgentApiErrorCodeInvalidRequest, "The question breaks the question card rules")
		return
	case errors.Is(err, typedcard.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeIdempotencyConflict, "This operation already posted a different question")
		return
	case errors.Is(err, typedcard.ErrForbidden), errors.Is(err, typedcard.ErrNotFound):
		a.writeAgentAPIError(c, http.StatusForbidden, api.AgentApiErrorCodeForbidden, "Questions are unavailable in this chat")
		return
	case err != nil:
		if a.logger != nil {
			a.logger.Error("ask user", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "Questions are temporarily unavailable")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, api.AgentAskUserResponse{InteractionId: result.DecisionID, MessageId: result.MessageID, Status: api.AgentAskUserResponseStatusPending})
}

// askUserQuestions names each question and option by its position: the
// Agent writes only text, and its answer comes back as the chosen labels.
// Every question offers options; an open question belongs in a message.
func askUserQuestions(questions []api.AgentAskUserQuestion) ([]typedcard.DecisionQuestion, bool) {
	cards := make([]typedcard.DecisionQuestion, 0, len(questions))
	for index, question := range questions {
		multiple := question.Multiple != nil && *question.Multiple
		card := typedcard.DecisionQuestion{ID: fmt.Sprintf("q%d", index+1), Prompt: question.Question, Input: "radio"}
		if multiple {
			card.Input = "checkbox"
		}
		seen := map[string]bool{}
		for optionIndex, label := range question.Options {
			label = strings.TrimSpace(label)
			if seen[label] {
				return nil, false
			}
			seen[label] = true
			card.Options = append(card.Options, typedcard.DecisionQuestionOption{ID: fmt.Sprintf("o%d", optionIndex+1), Label: label})
		}
		cards = append(cards, card)
	}
	return cards, true
}
