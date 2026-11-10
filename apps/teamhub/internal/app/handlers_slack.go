package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listSlackConversations(c *gin.Context) {
	params := contractParams[httpapi.ListSlackConversationsParams](c)
	cursor := ""
	limit := 100
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = *params.Limit
	}
	page, err := a.externalSources.ListSlackConversations(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"), cursor, limit)
	if a.writeExternalSourceError(c, "list Slack conversations", err) {
		return
	}
	response := httpapi.SlackConversationPage{Conversations: make([]httpapi.SlackConversation, 0, len(page.Conversations))}
	if page.NextCursor != "" {
		response.NextCursor = &page.NextCursor
	}
	for _, conversation := range page.Conversations {
		response.Conversations = append(response.Conversations, httpapi.SlackConversation{Id: conversation.ID, Name: conversation.Name, Kind: httpapi.SlackConversationKind(conversation.Kind), IsPrivate: conversation.IsPrivate})
	}
	c.JSON(http.StatusOK, response)
}
func (a *App) listDiscordChannels(c *gin.Context) {
	channels, err := a.externalSources.ListDiscordChannels(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"))
	if a.writeExternalSourceError(c, "list Discord channels", err) {
		return
	}
	response := httpapi.DiscordChannelList{Channels: make([]httpapi.DiscordChannel, 0, len(channels))}
	for _, channel := range channels {
		var kind httpapi.DiscordChannelKind
		switch channel.Type {
		case 0:
			kind = httpapi.DiscordChannelKindText
		case 5:
			kind = httpapi.DiscordChannelKindAnnouncement
		case 15:
			kind = httpapi.DiscordChannelKindForum
		case 16:
			kind = httpapi.DiscordChannelKindMedia
		default:
			continue
		}
		response.Channels = append(response.Channels, httpapi.DiscordChannel{Id: channel.ID, Name: channel.Name, Kind: kind})
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) listGitHubRepositories(c *gin.Context) {
	params := contractParams[httpapi.ListGitHubRepositoriesParams](c)
	cursor, limit := "", 50
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = *params.Limit
	}
	page, err := a.externalSources.ListGitHubRepositories(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"), cursor, limit)
	if a.writeExternalSourceError(c, "list GitHub repositories", err) {
		return
	}
	response := httpapi.GitHubRepositoryPage{Repositories: make([]httpapi.GitHubRepository, 0, len(page.Repositories))}
	if page.NextCursor != "" {
		response.NextCursor = &page.NextCursor
	}
	for _, repository := range page.Repositories {
		response.Repositories = append(response.Repositories, httpapi.GitHubRepository{Id: repository.RepositoryID, FullName: repository.FullName, Name: repository.Name, HtmlUrl: repository.HTMLURL, Description: repository.Description, Language: repository.Language, DefaultBranch: repository.DefaultBranch, UpdatedAt: repository.UpdatedAt})
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) listNotionResources(c *gin.Context) {
	params := contractParams[httpapi.ListNotionResourcesParams](c)
	cursor, limit := "", 50
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = *params.Limit
	}
	page, err := a.externalSources.ListNotionResources(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"), cursor, limit)
	if a.writeExternalSourceError(c, "list Notion resources", err) {
		return
	}
	response := httpapi.NotionResourcePage{Resources: make([]httpapi.NotionResource, 0, len(page.Resources))}
	if page.NextCursor != "" {
		response.NextCursor = &page.NextCursor
	}
	for _, resource := range page.Resources {
		item := httpapi.NotionResource{Id: resource.ID, Title: resource.Title, Kind: httpapi.NotionResourceKind(resource.Kind)}
		if resource.URL != "" {
			item.Url = &resource.URL
		}
		response.Resources = append(response.Resources, item)
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) listGoogleCalendars(c *gin.Context) {
	params := contractParams[httpapi.ListGoogleCalendarsParams](c)
	pageToken, limit := "", 100
	if params.PageToken != nil {
		pageToken = *params.PageToken
	}
	if params.Limit != nil {
		limit = *params.Limit
	}
	page, err := a.externalSources.ListGoogleCalendars(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("externalConnectionId"), pageToken, limit)
	if a.writeExternalSourceError(c, "list Google calendars", err) {
		return
	}
	response := httpapi.GoogleCalendarPage{Calendars: make([]httpapi.GoogleCalendar, 0, len(page.Calendars))}
	if page.NextPageToken != "" {
		response.NextPageToken = &page.NextPageToken
	}
	for _, calendar := range page.Calendars {
		response.Calendars = append(response.Calendars, httpapi.GoogleCalendar{Id: calendar.ID, Summary: calendar.Summary, TimeZone: &calendar.TimeZone, AccessRole: httpapi.GoogleCalendarAccessRole(calendar.AccessRole), Primary: calendar.Primary, Selected: calendar.Selected})
	}
	c.JSON(http.StatusOK, response)
}
