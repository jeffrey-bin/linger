package personalprofile

import (
	"context"
	"encoding/json"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// importConnection fetches one connection source for a generation. A mailbox
// is read from its published snapshot; every other source is fetched now and
// only returned. The error is a setup failure; fetch failures are the
// result's status.
func (s *Service) importConnection(ctx context.Context, accountID, tenantID string, source storedSource) (externalsource.TransientImportResult, error) {
	if s.external == nil {
		return externalsource.TransientImportResult{}, ErrUnsupportedSource
	}
	connectionID, selections := source.ConnectionID, source.Selections
	remoteIDs := make([]string, 0, len(selections))
	for _, selection := range selections {
		remoteIDs = append(remoteIDs, selection.RemoteID)
	}
	budget := s.options.AppImportProviderCallBudget
	switch source.Provider {
	case "gmail", "outlook":
		return s.external.ReadMailImport(ctx, accountID, tenantID, connectionID)
	case "discord":
		return s.external.ImportDiscord(ctx, accountID, tenantID, connectionID, externalsource.DiscordImportRequest{
			ChannelIDs: remoteIDs, Days: 7, MaxMessagesPerChannel: 500, IncludeThreads: true,
		}, budget)
	case "slack":
		return s.external.ImportSlack(ctx, accountID, tenantID, connectionID, externalsource.SlackImportRequest{
			ConversationIDs: remoteIDs, Days: 7, MaxMessagesPerConversation: 500, IncludeThreadReplies: true,
		}, budget)
	case "github":
		repositories := make([]externalsource.GitHubRepositorySelection, 0, len(selections))
		for _, selection := range selections {
			repositories = append(repositories, externalsource.GitHubRepositorySelection{RepositoryID: selection.RemoteID, FullName: selection.Name})
		}
		return s.external.ImportGitHub(ctx, accountID, tenantID, connectionID, externalsource.GitHubImportRequest{Repositories: repositories}, budget)
	case "notion":
		resources := make([]externalsource.NotionResourceSelection, 0, len(selections))
		for _, selection := range selections {
			resources = append(resources, externalsource.NotionResourceSelection{ResourceID: selection.RemoteID, Title: selection.Name, Kind: selection.Kind})
		}
		return s.external.ImportNotion(ctx, accountID, tenantID, connectionID, externalsource.NotionImportRequest{Resources: resources}, budget)
	case "google_calendar":
		return s.external.ImportGoogleCalendar(ctx, accountID, tenantID, connectionID, externalsource.GoogleCalendarImportRequest{
			CalendarIDs: remoteIDs, Days: 30, MaxEventsPerCalendar: 500,
		}, budget)
	default:
		return externalsource.TransientImportResult{}, externalsource.ErrInvalid
	}
}

func encodeSelections(selections []Selection) ([]byte, error) {
	if selections == nil {
		selections = []Selection{}
	}
	return json.Marshal(selections)
}

func decodeSelections(raw []byte) ([]Selection, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var selections []Selection
	if err := json.Unmarshal(raw, &selections); err != nil {
		return nil, err
	}
	return selections, nil
}
