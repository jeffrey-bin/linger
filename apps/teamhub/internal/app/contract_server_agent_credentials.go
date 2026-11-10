package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

func (a *App) issueManagedAgentAccessCredential(c *gin.Context) {
	agentID := c.Param("agentId")
	var input struct {
		Label            string `json:"label"`
		ComputerID       string `json:"computer_id"`
		WorkspaceGrantID string `json:"workspace_grant_id"`
		HeldTokenSHA256  string `json:"held_token_sha256"`
	}
	// The Gateway always names the Computer and workspace grant it installs
	// the credential on; issuance refuses a placement the Agent left.
	if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &input, "invalid credential request") != nil ||
		input.ComputerID == "" || input.WorkspaceGrantID == "" {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "invalid credential request")
		return
	}
	var held []byte
	if input.HeldTokenSHA256 != "" {
		decoded, err := hex.DecodeString(input.HeldTokenSHA256)
		if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != input.HeldTokenSHA256 {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "invalid credential request")
			return
		}
		held = decoded
	}
	issued, current, err := a.agentCredentials.EnsureManagedForPlacement(c.Request.Context(), agentID, input.Label,
		agentcredential.ExpectedPlacement{ComputerID: input.ComputerID, WorkspaceGrantID: input.WorkspaceGrantID}, held)
	if a.writeAgentCredentialError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	if current {
		c.Status(http.StatusNoContent)
		return
	}
	c.JSON(http.StatusCreated, issued)
}

func (a *App) writeAgentCredentialError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, agentcredential.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "invalid Agent credential request")
	case errors.Is(err, agentcredential.ErrForbidden):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "Agent credential operation is forbidden")
	default:
		a.internalError(c, "Agent credential operation", err)
	}
	return true
}
