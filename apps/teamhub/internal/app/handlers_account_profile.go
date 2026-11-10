package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) getAccountProfile(c *gin.Context) {
	session := currentPrincipal(c).Session
	profile, err := a.accountProfiles.Get(c.Request.Context(), session.AccountID, c.Param("tenantId"), session.Email)
	if a.writeAccountProfileError(c, "get Account profile", err) {
		return
	}
	c.JSON(http.StatusOK, accountProfileModel(profile))
}

func (a *App) patchAccountProfile(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1100000)
	var request httpapi.AccountProfileUpdateRequest
	if decodeStrictJSON(c.Request.Body, &request, "request body must contain one JSON object") != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Account profile input is invalid")
		return
	}
	session := currentPrincipal(c).Session
	profile, err := a.accountProfiles.Patch(c.Request.Context(), session.AccountID, c.Param("tenantId"), session.Email, account.Patch{
		AvatarImage: request.AvatarImage, BackgroundImage: request.BackgroundImage,
		Name: request.Name, Bio: request.Bio, Organization: request.Organization,
	})
	if a.writeAccountProfileError(c, "patch Account profile", err) {
		return
	}
	c.JSON(http.StatusOK, accountProfileModel(profile))
}

func (a *App) writeAccountProfileError(c *gin.Context, action string, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, account.ErrProfileInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Account profile input is invalid")
	case errors.Is(err, account.ErrProfileNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Account profile was not found")
	default:
		a.internalError(c, action, err)
	}
	return true
}

func accountProfileModel(value account.Profile) httpapi.AccountProfile {
	model := httpapi.AccountProfile{
		AvatarImage: &value.AvatarImage, BackgroundImage: &value.BackgroundImage,
		Name: value.Name, Bio: value.Bio, Organization: value.Organization,
		NameUserManaged: value.NameUserManaged, BioUserManaged: value.BioUserManaged,
		OrganizationUserManaged: value.OrganizationUserManaged, Email: value.Email,
	}
	if value.UpdatedAt != nil {
		model.UpdatedAt = value.UpdatedAt
	}
	return model
}
