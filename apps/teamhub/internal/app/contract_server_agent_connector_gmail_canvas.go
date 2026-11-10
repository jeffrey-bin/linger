package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// saveConnectorGmailCanvasDraft saves a canvas as a Gmail draft whose images
// show in the body and whose file blocks are attachments. Recipients and subject the request leaves out come from
// the canvas header. It never sends; send the returned draft separately.
func (a *App) saveConnectorGmailCanvasDraft(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input api.SaveConnectorGmailCanvasDraftJSONRequestBody
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10), &input, "invalid canvas draft"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid canvas draft request")
		return
	}
	ctx := c.Request.Context()
	auth, err := a.agentConnectedApps.AgentPrincipal(ctx, token)
	if a.writeAgentAuthError(c, "save Gmail canvas draft", err) {
		return
	}
	built, err := a.canvas.GmailCanvasDraftRaw(ctx, auth.TenantID, auth.AgentID, input.DocumentId, input.To, input.Cc, input.Subject)
	var invalid *agentconnectedapps.CanvasDraftError
	if errors.As(err, &invalid) {
		if invalid.Path == "" {
			a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, invalid.Message)
		} else {
			a.writeCanvasDraftInputError(c, invalid.Path, invalid.Code, invalid.Message)
		}
		return
	}
	if err != nil {
		a.writeCanvasDraftDocumentError(c, err)
		return
	}
	draftID := ""
	if input.DraftId != nil {
		draftID = *input.DraftId
	}
	draft, err := a.agentConnectedApps.SaveGmailDraft(connectorCallContext(c), token, input.ConnectionId, draftID, built.Raw)
	if a.writeAgentConnectedAppsError(c, "save Gmail canvas draft", err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{
		"draft_id": draft.DraftID, "message_id": draft.MessageID, "thread_id": draft.ThreadID,
		"inline_images": built.InlineImages, "attachments": built.Attachments,
	})
}

// writeCanvasDraftInputError names the field at fault as an issue, which the
// CLI shows the Agent.
func (a *App) writeCanvasDraftInputError(c *gin.Context, path, code, message string) {
	a.writeAgentAPIErrorWithIssues(c, 400, api.AgentApiErrorCodeInvalidInput, message,
		[]api.AgentApiErrorIssue{{Path: path, Code: code, Message: message}})
}

func (a *App) writeCanvasDraftDocumentError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, document.ErrNotFound):
		a.writeAgentAPIError(c, 404, api.AgentApiErrorCodeNotFound, "Canvas Document or image was not found")
	case errors.Is(err, document.ErrInvalidInput):
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Canvas has no body to send")
	default:
		a.writeAgentAPIError(c, 503, api.AgentApiErrorCodeDependencyUnavailable, "Canvas could not be read")
	}
}
