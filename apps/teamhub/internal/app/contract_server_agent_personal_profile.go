package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentProfileRequestMaxBytes = 256 << 10

// profileOwner resolves the Human who owns the calling AnotherMe. Tenant and
// owner come only from the Agent credential, never from the request.
func (a *App) profileOwner(c *gin.Context, tool string, request any) (tenantID, ownerActorID string, ok bool) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return "", "", false
	}
	auth, err := a.agentAuth.Authorize(c.Request.Context(), token, tool)
	if err == nil && (auth.Principal == nil || auth.UserArtifactOwnerActorID == "") {
		err = agentauth.ErrForbidden
	}
	if a.writeAgentAuthError(c, "authorize owner profile", err) {
		return "", "", false
	}
	if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, agentProfileRequestMaxBytes), request, "request body must contain one JSON object") != nil {
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidInput, "Profile request is invalid")
		return "", "", false
	}
	return auth.TenantID, auth.UserArtifactOwnerActorID, true
}

func (a *App) getAgentPersonalProfile(c *gin.Context) {
	tenantID, ownerActorID, ok := a.profileOwner(c, "get_personal_profile", &struct{}{})
	if !ok {
		return
	}
	profile, err := a.personalProfile.ProfileForActor(c.Request.Context(), tenantID, ownerActorID)
	if a.writeAgentProfileError(c, err) {
		return
	}
	response := teamhubagentapi.AgentPersonalProfileResponse{}
	if profile.Current != nil {
		response.Current = &teamhubagentapi.AgentPersonalProfileRevision{
			RevisionId: profile.Current.ID, Profile: agentProfileDocumentModel(profile.Current.Profile),
			Markdown: profile.Current.Markdown, CreatedAt: profile.Current.CreatedAt.UTC(),
		}
		if profile.Current.SourceApps != nil {
			response.Current.SourceApps = &profile.Current.SourceApps
		}
	}
	c.JSON(http.StatusOK, response)
}

// startAgentPersonalProfileBuild lets the Profile page say the Profile is
// being written while the Agent reads its sources.
func (a *App) startAgentPersonalProfileBuild(c *gin.Context) {
	var request teamhubagentapi.AgentPersonalProfileBuildRequest
	tenantID, ownerActorID, ok := a.profileOwner(c, "start_personal_profile_build", &request)
	if !ok {
		return
	}
	startedAt, err := a.personalProfile.StartBuild(c.Request.Context(), tenantID, ownerActorID)
	if a.writeAgentProfileError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentPersonalProfileBuildResponse{BuildingSince: startedAt.UTC()})
}

func (a *App) writeAgentPersonalProfile(c *gin.Context) {
	var request teamhubagentapi.AgentPersonalProfileWriteRequest
	tenantID, ownerActorID, ok := a.profileOwner(c, "write_personal_profile", &request)
	if !ok {
		return
	}
	var sourceApps []string
	if request.SourceApps != nil {
		sourceApps = append([]string{}, (*request.SourceApps)...)
	}
	revision, err := a.personalProfile.WriteRevision(c.Request.Context(), tenantID, ownerActorID, request.InvocationId, valueOrEmpty(request.BaseRevisionId), agentProfileDocument(request.Profile), sourceApps)
	if a.writeAgentProfileError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentPersonalProfileWriteResponse{RevisionId: revision.ID, CreatedAt: revision.CreatedAt.UTC()})
}

func (a *App) getAgentAccountProfile(c *gin.Context) {
	tenantID, ownerActorID, ok := a.profileOwner(c, "get_account_profile", &struct{}{})
	if !ok {
		return
	}
	profile, err := a.accountProfiles.GetActor(c.Request.Context(), tenantID, ownerActorID)
	if a.writeAgentProfileError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentAccountProfileResponse{Name: profile.Name, Bio: profile.Bio, Organization: profile.Organization})
}

// updateAgentAccountProfile sets fields, so a replayed invocation_id simply
// re-applies the same values; the key is required on the wire but not stored.
func (a *App) updateAgentAccountProfile(c *gin.Context) {
	var request teamhubagentapi.AgentAccountProfileUpdateRequest
	tenantID, ownerActorID, ok := a.profileOwner(c, "update_account_profile", &request)
	if !ok {
		return
	}
	if request.InvocationId == "" {
		a.writeAgentProfileError(c, account.ErrProfileInvalid)
		return
	}
	profile, err := a.accountProfiles.PatchActor(c.Request.Context(), tenantID, ownerActorID, account.Patch{
		Name: request.Name, Bio: request.Bio, Organization: request.Organization,
	})
	if a.writeAgentProfileError(c, err) {
		return
	}
	c.JSON(http.StatusOK, teamhubagentapi.AgentAccountProfileResponse{Name: profile.Name, Bio: profile.Bio, Organization: profile.Organization})
}

func (a *App) writeAgentProfileError(c *gin.Context, err error) bool {
	var documentErr *personalprofile.DocumentError
	switch {
	case err == nil:
		return false
	case errors.As(err, &documentErr):
		code, message := teamhubagentapi.AgentApiErrorCodeProfileDocumentInvalid, "The Profile document has an invalid field"
		if documentErr.Code == personalprofile.ModuleEmpty {
			code, message = teamhubagentapi.AgentApiErrorCodeProfileModuleEmpty, "Every Profile module needs an overview or at least one point"
		}
		a.writeAgentAPIErrorWithIssues(c, http.StatusBadRequest, code, message, []teamhubagentapi.AgentApiErrorIssue{{
			Path: documentErr.Field, Code: string(documentErr.Code), Message: message,
		}})
	case errors.Is(err, personalprofile.ErrInvalid), errors.Is(err, account.ErrProfileInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidInput, "Profile input is invalid")
	case errors.Is(err, personalprofile.ErrConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeProfileRevisionConflict,
			"The Personal Profile changed since it was read. Run teamhub personal-profile show, merge your changes into its current profile, and write again with its revision_id.")
	case errors.Is(err, personalprofile.ErrIdempotencyReused):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "This Profile write was already used with different input")
	case errors.Is(err, personalprofile.ErrNotFound), errors.Is(err, account.ErrProfileNotFound):
		a.writeAgentAPIError(c, http.StatusNotFound, teamhubagentapi.AgentApiErrorCodeNotFound, "The owner's Profile is not available")
	default:
		if a.logger != nil {
			a.logger.Error("Agent owner profile", "request_id", c.GetString("request_id"), "error_type", err.Error())
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Profile service could not complete the request")
	}
	return true
}

func agentProfileDocument(value teamhubagentapi.PersonalProfileDocument) personalprofile.Document {
	timeline := make([]personalprofile.TimelineEntry, 0, len(value.Background.Timeline))
	for _, entry := range value.Background.Timeline {
		timeline = append(timeline, personalprofile.TimelineEntry(entry))
	}
	module := func(value teamhubagentapi.PersonalProfileModule) personalprofile.Module {
		return personalprofile.Module{Overview: value.Overview, Points: agentProfilePoints(value.Points)}
	}
	return personalprofile.Document{
		Name:               value.Name,
		Background:         personalprofile.Background{Overview: value.Background.Overview, Points: agentProfilePoints(value.Background.Points), Timeline: timeline},
		CommunicationStyle: module(value.CommunicationStyle),
		WorkingStyle:       module(value.WorkingStyle),
		Preferences:        module(value.Preferences),
		WritingStyle:       module(value.WritingStyle),
	}
}

func agentProfilePoints(values []teamhubagentapi.PersonalProfilePoint) []personalprofile.Point {
	points := make([]personalprofile.Point, 0, len(values))
	for _, point := range values {
		points = append(points, personalprofile.Point(point))
	}
	return points
}

func agentProfileDocumentModel(value personalprofile.Document) teamhubagentapi.PersonalProfileDocument {
	timeline := make([]teamhubagentapi.PersonalProfileTimelineEntry, 0, len(value.Background.Timeline))
	for _, entry := range value.Background.Timeline {
		timeline = append(timeline, teamhubagentapi.PersonalProfileTimelineEntry(entry))
	}
	points := func(values []personalprofile.Point) []teamhubagentapi.PersonalProfilePoint {
		out := make([]teamhubagentapi.PersonalProfilePoint, 0, len(values))
		for _, point := range values {
			out = append(out, teamhubagentapi.PersonalProfilePoint(point))
		}
		return out
	}
	module := func(value personalprofile.Module) teamhubagentapi.PersonalProfileModule {
		return teamhubagentapi.PersonalProfileModule{Overview: value.Overview, Points: points(value.Points)}
	}
	return teamhubagentapi.PersonalProfileDocument{
		Name:               value.Name,
		Background:         teamhubagentapi.PersonalProfileBackground{Overview: value.Background.Overview, Points: points(value.Background.Points), Timeline: timeline},
		CommunicationStyle: module(value.CommunicationStyle),
		WorkingStyle:       module(value.WorkingStyle),
		Preferences:        module(value.Preferences),
		WritingStyle:       module(value.WritingStyle),
	}
}
