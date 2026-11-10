package app

import (
	"bytes"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// maxPermissionScreenshotBytes bounds a stored screenshot; the contract
// allows at most 2 MiB decoded.
const maxPermissionScreenshotBytes = 2 << 20

// permissionReviewTimeout bounds one judgement: a foreground model call that
// starts at once and makes a single Runtime attempt with no schema
// correction. The remaining request budget creates a human
// approval card and delivers it before the Daemon stops waiting.
const permissionReviewTimeout = 15 * time.Second

func (a *App) createRuntimePermissionReview(c *gin.Context) {
	var input teamhubinternal.CreateRuntimePermissionReviewRequest
	if !a.decodeAgentRuntimeStateBody(c, &input) {
		return
	}
	if input.ContextKey == "" || input.ExecutionRunRef == "" || input.OperationId == "" || input.RequestId == "" || input.Action.Tool == "" {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Permission review is invalid")
		return
	}
	review := permissionReviewInput(input)
	screenshot, err := permissionReviewScreenshot(input.Evidence)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Permission review screenshot is invalid")
		return
	}
	review.Evidence.Screenshot = screenshot
	outcome, err := a.permissionReviews.Review(c.Request.Context(), review)
	switch {
	case errors.Is(err, permissionreview.ErrForbidden):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "This Context does not use permission reviews")
		return
	case errors.Is(err, permissionreview.ErrConflict):
		a.writeError(c, http.StatusConflict, "CONFLICT", "Permission review no longer belongs to an active execution")
		return
	case err != nil:
		slog.ErrorContext(c.Request.Context(), "permission review", "context_key", input.ContextKey, "tool", input.Action.Tool, "error", err)
		a.writeError(c, http.StatusServiceUnavailable, "DEPENDENCY_UNAVAILABLE", "Permission review is unavailable")
		return
	}
	slog.InfoContext(c.Request.Context(), "permission review", "context_key", input.ContextKey, "tool", input.Action.Tool,
		"decision", outcome.Decision, "interaction_id", outcome.InteractionID, "policy_version", permissionreview.PolicyVersion)
	result := teamhubinternal.RuntimePermissionReviewResult{
		Decision: teamhubinternal.RuntimePermissionReviewResultDecision(outcome.Decision),
		Message:  outcome.Message, PolicyVersion: permissionreview.PolicyVersion,
	}
	if outcome.InteractionID != "" {
		result.InteractionId = &outcome.InteractionID
	}
	c.JSON(http.StatusOK, result)
}

func permissionReviewInput(input teamhubinternal.CreateRuntimePermissionReviewRequest) permissionreview.ReviewInput {
	text := func(value *string) string {
		if value == nil {
			return ""
		}
		return *value
	}
	review := permissionreview.ReviewInput{
		ContextKey: input.ContextKey, RunID: input.ExecutionRunRef, OperationID: input.OperationId, RequestID: input.RequestId,
		Action: permissionreview.Action{
			Runtime: string(input.Action.Runtime), Surface: string(input.Action.Surface), Tool: input.Action.Tool,
			Command: text(input.Action.Command), Input: text(input.Action.Input), Subagent: text(input.Action.Subagent),
		},
	}
	review.Environment.Runtime = string(input.Action.Runtime)
	if env := input.Environment; env != nil {
		review.Environment.RuntimeVersion, review.Environment.Platform = text(env.RuntimeVersion), text(env.Platform)
		review.Environment.Sandbox, review.Environment.Workspace = text(env.Sandbox), text(env.Workspace)
	}
	if input.Transcript != nil {
		for _, entry := range *input.Transcript {
			review.Transcript = append(review.Transcript, permissionreview.TranscriptEntry{
				Kind: string(entry.Kind), Tool: text(entry.Tool), Text: entry.Text, Truncated: entry.Truncated != nil && *entry.Truncated,
			})
		}
	}
	if evidence := input.Evidence; evidence != nil {
		review.Evidence.Patch = text(evidence.Patch)
		if evidence.Missing != nil {
			review.Evidence.Missing = *evidence.Missing
		}
		if script := evidence.Script; script != nil {
			review.Evidence.Script = &permissionreview.ScriptEvidence{Path: script.Path, SHA256: text(script.Sha256), Body: script.Body}
		}
		if browser := evidence.Browser; browser != nil {
			review.Evidence.Browser = &permissionreview.BrowserEvidence{
				URL: browser.Url, Title: text(browser.Title), TargetRole: text(browser.TargetRole),
				TargetName: text(browser.TargetName), FormFields: text(browser.FormFields),
			}
		}
		if desktop := evidence.Desktop; desktop != nil {
			review.Evidence.Desktop = &permissionreview.DesktopEvidence{App: text(desktop.App), WindowTitle: text(desktop.WindowTitle)}
			if desktop.Targets != nil {
				for _, target := range *desktop.Targets {
					review.Evidence.Desktop.Targets = append(review.Evidence.Desktop.Targets, permissionreview.DesktopTarget{
						Token: target.Token, Role: target.Role, Name: text(target.Name),
					})
				}
			}
		}
	}
	return review
}

// permissionReviewScreenshot decodes the host's screenshot. It is served to
// the approver as stored, so the bytes must be the image the media type names.
func permissionReviewScreenshot(evidence *teamhubinternal.RuntimePermissionEvidence) (*permissionreview.ScreenshotEvidence, error) {
	if evidence == nil || evidence.Screenshot == nil {
		return nil, nil
	}
	shot := evidence.Screenshot
	data, err := base64.StdEncoding.DecodeString(shot.Data)
	if err != nil || len(data) == 0 || len(data) > maxPermissionScreenshotBytes || shot.Width < 1 || shot.Height < 1 {
		return nil, errors.New("invalid screenshot")
	}
	signature := map[teamhubinternal.RuntimePermissionEvidenceScreenshotMediaType][]byte{
		teamhubinternal.Imagejpeg: {0xFF, 0xD8, 0xFF},
		teamhubinternal.Imagepng:  []byte("\x89PNG\r\n\x1a\n"),
	}[shot.MediaType]
	if signature == nil || !bytes.HasPrefix(data, signature) {
		return nil, errors.New("screenshot is not the image its media type names")
	}
	return &permissionreview.ScreenshotEvidence{MediaType: string(shot.MediaType), Data: data, Width: shot.Width, Height: shot.Height}, nil
}

// getDecisionScreenshot serves a permission card's screenshot to the card's
// decision owner only.
func (a *App) getDecisionScreenshot(c *gin.Context) {
	decisionID := c.Param("decisionId")
	mediaType, image, err := a.typedCards.RuntimePermissionScreenshot(c.Request.Context(), currentPrincipal(c).Session.AccountID, decisionID)
	if errors.Is(err, typedcard.ErrNotFound) {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Screenshot not found")
		return
	}
	if err != nil {
		a.internalError(c, "read permission screenshot", err)
		return
	}
	// The image never changes; keep it out of shared caches and never
	// let a browser treat it as anything but an image.
	c.Header("Cache-Control", "private, max-age=86400, immutable")
	c.Header("Content-Security-Policy", "default-src 'none'; sandbox")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, mediaType, image)
}
