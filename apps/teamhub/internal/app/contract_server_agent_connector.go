package app

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

func (a *App) prepareConnectorFileUpload(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input agentconnectedapps.FileUploadInput
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 8192), &input, "invalid upload metadata"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid file upload metadata")
		return
	}
	target, err := a.agentConnectedApps.PrepareFileUpload(connectorCallContext(c), token, input)
	if a.writeAgentConnectedAppsError(c, "prepare connector file upload", err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, target)
}

// Account selection never borrows a Human's connection. Only the existing card
// decision can create a grant; this endpoint merely requests that decision.
func (a *App) resolveConnectorAccount(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input struct {
		AppKey  string  `json:"app_key"`
		Account *string `json:"account,omitempty"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &input, "invalid account selector"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid account selector")
		return
	}
	selector := ""
	if input.Account != nil {
		selector = *input.Account
	}
	if input.AppKey == "" || strings.TrimSpace(input.AppKey) != input.AppKey || utf8.RuneCountInString(input.AppKey) > 120 || strings.ContainsAny(input.AppKey, "\r\n\x00") || input.Account != nil && (selector == "" || strings.TrimSpace(selector) != selector || utf8.RuneCountInString(selector) > 240 || strings.ContainsAny(selector, "\r\n\x00")) {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid application key or account selector")
		return
	}
	// No account can be connected without the deployment's Composio key, so
	// the user is asked for the key first; the Agent then asks again.
	if !a.externalSources.ProviderConfigured() {
		if !slices.ContainsFunc(a.externalSources.ListApps(), func(app externalsource.ExternalApp) bool { return app.Key == input.AppKey }) {
			a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Unsupported application")
			return
		}
		a.requestProviderKey(c, token, input.AppKey)
		return
	}
	connections, err := a.agentConnectedApps.List(c.Request.Context(), token)
	if a.writeAgentConnectedAppsError(c, "resolve connector account", err) {
		return
	}
	selected, candidates := selectConnectorAccount(connections, input.AppKey, selector)
	c.Header("Cache-Control", "no-store")
	if selected != nil {
		c.JSON(200, gin.H{"status": "ready", "account": agentConnectedAppToContract(*selected)})
		return
	}
	if len(candidates) > 1 {
		items := make([]api.AgentConnectedApp, len(candidates))
		for i, candidate := range candidates {
			items[i] = agentConnectedAppToContract(candidate)
		}
		c.JSON(200, gin.H{"status": "account_ambiguous", "candidates": items})
		return
	}
	if !a.externalSources.SupportsAgentTools(input.AppKey) {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Unsupported application")
		return
	}
	prompt := fmt.Sprintf("Please connect and authorize the %s account so the command can continue.", input.AppKey)
	if selector != "" {
		prompt = fmt.Sprintf("Please connect and authorize the %s account %s so the command can continue.", input.AppKey, selector)
	}
	if roomID, card, ok := a.postConnectorCard(c, token, prompt, typedcard.DecisionCommand{
		ConnectionAuth: &typedcard.ConnectionAuthDecision{Prompt: prompt, AppKey: input.AppKey, ReusePending: true},
	}); ok {
		c.JSON(200, gin.H{"status": "authorization_required", "room_id": roomID, "message_id": card.MessageID, "interaction_id": card.DecisionID})
	}
}

// requestProviderKey posts, or reuses, the card asking the Agent's Human for
// the deployment's Composio API key, and answers provider_key_required so the
// Agent runs the command again once the key is saved. appKey names the app
// that needed it, when the command said.
func (a *App) requestProviderKey(c *gin.Context, token, appKey string) {
	prompt := "Please add a Composio API key so I can use connected apps."
	if slices.ContainsFunc(a.externalSources.ListApps(), func(app externalsource.ExternalApp) bool { return app.Key == appKey }) {
		prompt = fmt.Sprintf("Please add a Composio API key so I can connect %s. Every connected app needs it.", appKey)
	} else {
		appKey = ""
	}
	if _, _, ok := a.postConnectorCard(c, token, prompt, typedcard.DecisionCommand{
		ProviderKey: &typedcard.ProviderKeyDecision{Prompt: prompt, AppKey: appKey},
	}); ok {
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeProviderKeyRequired,
			"The user has not added a Composio API key; a card asking for it was posted in this chat")
	}
}

// askForProviderKey answers a connected app command refused only because the
// deployment has no Composio API key with the card that asks for it.
func (a *App) askForProviderKey(c *gin.Context, token, appKey string, err error) bool {
	if !errors.Is(err, agentauth.ErrProviderKeyRequired) {
		return false
	}
	a.requestProviderKey(c, token, appKey)
	return true
}

// postConnectorCard posts the card that asks the Agent's Human for what a
// connector command still needs. It writes the error response itself and
// reports whether the card was posted.
func (a *App) postConnectorCard(c *gin.Context, token, prompt string, command typedcard.DecisionCommand) (string, typedcard.CreateResult, bool) {
	c.Header("Cache-Control", "no-store")
	auth, err := a.agentAuth.Authorize(c.Request.Context(), token, "list_connected_apps")
	if a.writeAgentAuthError(c, "request connector authorization", err) {
		return "", typedcard.CreateResult{}, false
	}
	if auth.Principal == nil || auth.SponsorActorID == "" {
		a.writeAgentAPIError(c, 403, api.AgentApiErrorCodeForbidden, "Connection authorization requires an eligible chat and Human decision owner")
		return "", typedcard.CreateResult{}, false
	}
	roomID := auth.RoomID
	if auth.ParticipantTaskID != "" {
		// A delegated Task's card goes to the Room that delegated it.
		roomID, err = a.sponsorConfirmationRoom(c.Request.Context(), auth)
	} else if roomID == "" && auth.Target.Kind == "" {
		roomID, err = a.collaboration.CurrentDirectRoom(c.Request.Context(), auth.TenantID, auth.SponsorActorID, auth.AgentActorID)
	}
	if err != nil || roomID == "" {
		a.writeAgentAPIError(c, 403, api.AgentApiErrorCodeForbidden, "Run this command from an eligible Room or Task chat to request account authorization")
		return "", typedcard.CreateResult{}, false
	}
	digest := sha256.Sum256([]byte(roomID + "\x00" + auth.AgentActorID + "\x00" + prompt))
	// A fresh key allows a new request after denial/expiry; the service deduplicates
	// pending cards under the same membership lock used by grant decisions.
	key := "connector-auth-" + idgen.New("request")
	command.Principal, command.DeciderActorID, command.AlterEgoTaskID = auth.Principal, auth.SponsorActorID, auth.ParticipantTaskID
	result, err := a.typedCards.CreateDecision(c.Request.Context(), roomID, auth.AgentID, key, digest[:], command)
	if err != nil {
		if errors.Is(err, typedcard.ErrForbidden) || errors.Is(err, typedcard.ErrNotFound) || errors.Is(err, typedcard.ErrInvalid) {
			a.writeAgentAPIError(c, 403, api.AgentApiErrorCodeForbidden, "Connection authorization is unavailable in this chat")
		} else {
			a.writeAgentAPIError(c, 503, api.AgentApiErrorCodeDependencyUnavailable, "Connection authorization is temporarily unavailable")
		}
		return "", typedcard.CreateResult{}, false
	}
	return roomID, result, true
}

func selectConnectorAccount(connections []agentconnectedapps.ConnectedApp, app, selector string) (*agentconnectedapps.ConnectedApp, []agentconnectedapps.ConnectedApp) {
	items := make([]agentconnectedapps.ConnectedApp, 0)
	for _, connection := range connections {
		if connection.AppKey != app {
			continue
		}
		if selector != "" && connection.ConnectionID == selector {
			return &connection, nil
		}
		if selector == "" || connection.Identity == selector {
			items = append(items, connection)
		}
	}
	if len(items) == 1 {
		return &items[0], nil
	}
	return nil, items
}

func (a *App) prepareConnectorMailBody(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input struct {
		Content string `json:"content"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 6<<20), &input, "invalid mail body"); err != nil || len(input.Content) > 1<<20 {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Mail body exceeds its UTF-8 size limit or is invalid")
		return
	}
	_, err := a.agentAuth.Authorize(c.Request.Context(), token, "list_connected_apps")
	if a.writeAgentAuthError(c, "prepare mail body", err) {
		return
	}
	html, err := agentconnectedapps.MailMarkdownHTML(input.Content)
	if errors.Is(err, agentconnectedapps.ErrMailRawHTML) {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Raw HTML in Markdown is unsupported; use --html for an HTML body")
		return
	}
	if err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Mail Markdown could not be converted")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"html": html})
}

func (a *App) bindConnectorTools(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input agentconnectedapps.BindToolsInput
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 8192), &input, "invalid bindings"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid fixed tool bindings")
		return
	}
	result, err := a.agentConnectedApps.BindTools(c.Request.Context(), token, input)
	if a.writeAgentConnectedAppsError(c, "bind connector tools", err) {
		return
	}
	tools := make([]gin.H, 0, len(result))
	for _, tool := range result {
		tools = append(tools, gin.H{"tool_slug": tool.ToolSlug, "tool_version": tool.ToolVersion, "app_key": tool.AppKey, "input_schema": tool.InputSchema})
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"tools": tools})
}

func (a *App) prepareConnectorNotionBody(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input struct {
		Content  string `json:"content"`
		Markdown bool   `json:"markdown"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 6<<20), &input, "invalid body"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid Notion body")
		return
	}
	_, err := a.agentAuth.Authorize(c.Request.Context(), token, "list_connected_apps")
	if a.writeAgentAuthError(c, "prepare Notion body", err) {
		return
	}
	result, err := prepareNotionBody(input.Content, input.Markdown)
	if err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Unsupported Notion Markdown structure or content limit")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, result)
}
