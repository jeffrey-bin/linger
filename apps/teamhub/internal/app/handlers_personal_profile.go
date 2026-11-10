package app

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) createPersonalProfileGeneration(c *gin.Context) {
	var request httpapi.PersonalProfileGenerationCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Personal Profile generation input is invalid")
		return
	}
	sources := make([]personalprofile.SourceInput, 0, len(request.Sources))
	for _, item := range request.Sources {
		source := personalprofile.SourceInput{Kind: string(item.Kind)}
		if item.InputVersionId != nil {
			source.InputVersionID = *item.InputVersionId
		}
		if item.ConnectionId != nil {
			source.ConnectionID = *item.ConnectionId
		}
		if item.Summary != nil {
			source.ExternalAISummary = *item.Summary
		}
		if item.Selections != nil {
			for _, selection := range *item.Selections {
				source.Selections = append(source.Selections, personalprofile.Selection{
					RemoteID: selection.RemoteId, Name: selection.Name, Kind: string(selection.Kind), IsPrivate: selection.IsPrivate,
				})
			}
		}
		sources = append(sources, source)
	}
	generation, err := a.personalProfile.CreateGeneration(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), sources)
	if a.writePersonalProfileError(c, "create Personal Profile generation", err) {
		return
	}
	c.JSON(http.StatusCreated, personalProfileGenerationModel(generation))
}

func (a *App) listPersonalProfileGenerations(c *gin.Context) {
	items, err := a.personalProfile.ListGenerations(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"))
	if a.writePersonalProfileError(c, "list Personal Profile generations", err) {
		return
	}
	model := httpapi.PersonalProfileGenerationList{Items: make([]httpapi.PersonalProfileGeneration, 0, len(items))}
	for _, item := range items {
		model.Items = append(model.Items, personalProfileGenerationModel(item))
	}
	c.JSON(http.StatusOK, model)
}

func (a *App) getPersonalProfile(c *gin.Context) {
	profile, err := a.personalProfile.GetProfile(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"))
	if a.writePersonalProfileError(c, "get Personal Profile", err) {
		return
	}
	model := httpapi.PersonalProfile{History: make([]httpapi.PersonalProfileRevision, 0, len(profile.History)), HasMore: profile.HasMore}
	for _, revision := range profile.History {
		model.History = append(model.History, profileRevisionModel(revision))
	}
	if profile.Current != nil {
		value := profileRevisionModel(*profile.Current)
		model.Current = &value
	}
	if profile.BuildingSince != nil {
		since := profile.BuildingSince.UTC()
		model.BuildingSince = &since
	}
	c.JSON(http.StatusOK, model)
}

// replacePersonalProfile publishes the Human's own edit of their Profile.
func (a *App) replacePersonalProfile(c *gin.Context) {
	var request httpapi.PersonalProfileReplaceRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Personal Profile input is invalid")
		return
	}
	revision, err := a.personalProfile.ReplaceRevision(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("tenantId"), request.BaseRevisionId, request.Markdown)
	var markdownErr *personalprofile.MarkdownError
	if errors.As(err, &markdownErr) {
		a.writeError(c, http.StatusBadRequest, "profile_markdown_invalid", fmt.Sprintf("Line %d: %s.", markdownErr.Line, markdownErr.Reason))
		return
	}
	var documentErr *personalprofile.DocumentError
	if errors.As(err, &documentErr) {
		message := fmt.Sprintf("The Profile has an invalid value at %s.", documentErr.Field)
		if documentErr.Code == personalprofile.ModuleEmpty {
			message = fmt.Sprintf("The %s section needs some text.", documentErr.Field)
		}
		a.writeError(c, http.StatusBadRequest, string(documentErr.Code), message)
		return
	}
	if a.writePersonalProfileError(c, "replace Personal Profile", err) {
		return
	}
	c.JSON(http.StatusOK, profileRevisionModel(revision))
}

func profileRevisionModel(value personalprofile.Revision) httpapi.PersonalProfileRevision {
	model := httpapi.PersonalProfileRevision{Id: value.ID, TenantId: value.TenantID, PromptVersion: value.PromptVersion, Profile: profileDocumentModel(value.Profile), Markdown: value.Markdown, CreatedAt: value.CreatedAt}
	if value.SourceApps != nil {
		model.SourceApps = &value.SourceApps
	}
	if value.SourceProfileGenerationID != "" {
		model.SourceProfileGenerationId = ptr(value.SourceProfileGenerationID)
	}
	return model
}

func profileDocumentModel(value personalprofile.Document) httpapi.PersonalProfileDocument {
	timeline := make([]httpapi.PersonalProfileTimelineEntry, 0, len(value.Background.Timeline))
	for _, entry := range value.Background.Timeline {
		timeline = append(timeline, httpapi.PersonalProfileTimelineEntry(entry))
	}
	points := func(values []personalprofile.Point) []httpapi.PersonalProfilePoint {
		out := make([]httpapi.PersonalProfilePoint, 0, len(values))
		for _, point := range values {
			out = append(out, httpapi.PersonalProfilePoint(point))
		}
		return out
	}
	module := func(value personalprofile.Module) httpapi.PersonalProfileModule {
		return httpapi.PersonalProfileModule{Overview: value.Overview, Points: points(value.Points)}
	}
	return httpapi.PersonalProfileDocument{
		Name:               value.Name,
		Background:         httpapi.PersonalProfileBackground{Overview: value.Background.Overview, Points: points(value.Background.Points), Timeline: timeline},
		CommunicationStyle: module(value.CommunicationStyle),
		WorkingStyle:       module(value.WorkingStyle),
		Preferences:        module(value.Preferences),
		WritingStyle:       module(value.WritingStyle),
	}
}

func (a *App) writePersonalProfileError(c *gin.Context, action string, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, personalprofile.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Personal Profile input is invalid")
	case errors.Is(err, personalprofile.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Personal Profile resource was not found")
	case errors.Is(err, personalprofile.ErrConflict):
		a.writeError(c, http.StatusConflict, "PROFILE_CONFLICT", "Personal Profile request conflicts with current state")
	case errors.Is(err, personalprofile.ErrUnsupportedSource):
		a.writeError(c, http.StatusUnprocessableEntity, "PROFILE_SOURCE_UNSUPPORTED", "This source is not available for Profile updates")
	default:
		a.internalError(c, action, err)
	}
	return true
}

func personalProfileGenerationModel(value personalprofile.Generation) httpapi.PersonalProfileGeneration {
	model := httpapi.PersonalProfileGeneration{
		Id: value.ID, TenantId: value.TenantID, Status: httpapi.PersonalProfileGenerationStatus(value.Status),
		DecisionStatus: httpapi.PersonalProfileGenerationDecision(value.DecisionStatus), PromptVersion: value.PromptVersion,
		Sources: make([]httpapi.PersonalProfileGenerationSource, 0, len(value.Sources)), CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
	if value.BaseProfileRevisionID != "" {
		model.BaseProfileRevisionId = ptr(value.BaseProfileRevisionID)
	}
	if value.CandidateRevisionID != "" {
		model.CandidateRevisionId = ptr(value.CandidateRevisionID)
	}
	if value.LastErrorCode != "" {
		model.LastErrorCode = &value.LastErrorCode
	}
	if value.CompletedAt != nil {
		model.CompletedAt = value.CompletedAt
	}
	for _, source := range value.Sources {
		item := httpapi.PersonalProfileGenerationSource{Kind: httpapi.PersonalProfileSourceKind(source.Kind)}
		if source.InputVersionID != "" {
			item.InputVersionId = ptr(source.InputVersionID)
		}
		if source.Filename != "" {
			item.Filename = &source.Filename
		}
		if source.MediaType != "" {
			item.MediaType = &source.MediaType
		}
		if source.Kind == "input_version" {
			size := source.SizeBytes
			item.SizeBytes = &size
			deleted := source.FileDeleted
			item.FileDeleted = &deleted
		}
		if source.ConnectionID != "" {
			item.ConnectionId = ptr(source.ConnectionID)
		}
		if source.Provider != "" {
			item.Provider = &source.Provider
		}
		if source.IdentityLabel != "" {
			item.IdentityLabel = &source.IdentityLabel
		}
		model.Sources = append(model.Sources, item)
	}
	return model
}
