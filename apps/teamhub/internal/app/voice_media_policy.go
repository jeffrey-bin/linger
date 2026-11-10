package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) getVoiceMediaPolicy(c *gin.Context) {
	policy, err := a.voice.MediaPolicy(c.Request.Context(), store.GetVoiceMediaPolicyForAccountParams{
		AccountID: currentPrincipal(c).Session.AccountID, TenantID: c.Param("tenantId"),
		AuthSessionID: currentPrincipal(c).Session.ID,
	})
	if a.writeVoiceMediaError(c, "resolve Voice media policy", err) {
		return
	}
	live := a.voiceMedia != nil && a.cfg.Voice.XaiAPIKey != ""
	response := httpapi.VoiceMediaPolicy{
		LiveSupported: &live, LiveEnabled: &live,
		VoiceMediaSupported: a.voiceTranscription,
	}
	if policy.LivekitRoomID != "" {
		response.ActiveRoomId = &policy.LivekitRoomID
	}
	c.JSON(http.StatusOK, response)
}
