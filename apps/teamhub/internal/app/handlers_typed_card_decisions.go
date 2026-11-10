package app

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) decideDecision(c *gin.Context) {
	var request httpapi.DecisionRequest
	if err := decodeJSON(c, &request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Decision is invalid")
		return
	}
	command := typedcard.DecisionAnswerCommand{ExpectedVersion: request.ExpectedVersion, Decision: string(request.Decision)}
	if request.Comment != nil {
		command.Comment = *request.Comment
	}
	if request.ConnectionId != nil {
		command.ConnectionID = *request.ConnectionId
	}
	if request.Answers != nil {
		answers, err := decisionAnswers(*request.Answers)
		if err != nil {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Decision is invalid")
			return
		}
		command.Answers = answers
	}
	if request.Links != nil {
		command.Links = *request.Links
	}
	if request.AttachmentUploadIds != nil {
		command.AttachmentUploadIDs = *request.AttachmentUploadIds
	}
	result, err := a.typedCards.DecideDecision(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("decisionId"), command)
	if a.writeTypedCardError(c, err) {
		return
	}
	// A sources card's uploads fail as they do on ordinary message creation.
	if errors.Is(err, collaboration.ErrAttachmentUploadUnavailable) {
		a.writeError(c, http.StatusConflict, "ATTACHMENT_UPLOAD_UNAVAILABLE", "message attachment upload is unavailable")
		return
	}
	if err != nil {
		a.internalError(c, "decide decision card", err)
		return
	}
	c.Data(result.Status, "application/json; charset=utf-8", result.Body)
}

func (a *App) writeTypedCardError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, typedcard.ErrNotFound), errors.Is(err, workitem.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "CARD_SOURCE_NOT_FOUND", "typed card source was not found")
	case errors.Is(err, typedcard.ErrConflict), errors.Is(err, workitem.ErrConflict):
		a.writeError(c, http.StatusConflict, "CARD_CONFLICT", "typed card state conflicts with the request")
	case errors.Is(err, typedcard.ErrInvalid), errors.Is(err, workitem.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_CARD", "typed card payload is invalid")
	case errors.Is(err, typedcard.ErrForbidden):
		a.writeError(c, http.StatusForbidden, "CARD_FORBIDDEN", "the acting Actor cannot decide this card")
	default:
		return false
	}
	return true
}

// decisionAnswers reads a question card's answers as plain values: a string,
// or a list of strings.
func decisionAnswers(answers map[string]httpapi.DecisionAnswerValue) (map[string]any, error) {
	encoded, err := json.Marshal(answers)
	if err != nil {
		return nil, err
	}
	var values map[string]any
	return values, json.Unmarshal(encoded, &values)
}
