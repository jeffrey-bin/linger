package externalsource

import (
	"context"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

func validateDiscordGuildID(guildID string) error {
	if len(guildID) < 17 || len(guildID) > 20 {
		return ErrInvalid
	}
	for _, character := range guildID {
		if character < '0' || character > '9' {
			return ErrInvalid
		}
	}
	return nil
}

func (s *Service) ListDiscordChannels(ctx context.Context, accountID, connectionID string) ([]composio.DiscordChannel, error) {
	if s.provider == nil {
		return nil, ErrUnavailable
	}
	connection, err := s.loadProviderConnection(ctx, accountID, connectionID, "discord")
	if err != nil {
		return nil, err
	}
	if connection.Status != "active" {
		return nil, ErrNotActive
	}
	remoteStatus, err := statusForImportProvider(ctx, s.provider, connection.UpstreamConnectionID, "discord")
	if err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	if remoteStatus != composio.ConnectionActive {
		return nil, ErrNotActive
	}
	if validateDiscordGuildID(connection.RemoteTeamID) != nil || connection.RemotePrincipalKey != "discord:guild:"+connection.RemoteTeamID {
		return nil, ErrConflict
	}
	identity, err := s.provider.GetDiscordGuild(ctx, connection.UpstreamConnectionID, connection.RemoteTeamID)
	if err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	if identity.GuildID != connection.RemoteTeamID {
		return nil, ErrConflict
	}
	channels, err := s.provider.ListDiscordChannels(ctx, connection.UpstreamConnectionID, identity.GuildID)
	if err != nil {
		return nil, errors.Join(ErrUnavailable, err)
	}
	if err := s.requireCurrentSelectionConnection(ctx, accountID, connection, "discord"); err != nil {
		return nil, err
	}
	return channels, nil
}

func (s *Service) ListGoogleCalendars(ctx context.Context, accountID, connectionID, pageToken string, limit int) (composio.GoogleCalendarPage, error) {
	if s.provider == nil || limit < 1 || limit > 250 {
		return composio.GoogleCalendarPage{}, ErrInvalid
	}
	connection, err := s.loadProviderConnection(ctx, accountID, connectionID, "google_calendar")
	if err != nil {
		return composio.GoogleCalendarPage{}, err
	}
	if connection.Status != "active" {
		return composio.GoogleCalendarPage{}, ErrNotActive
	}
	remoteStatus, err := statusForImportProvider(ctx, s.provider, connection.UpstreamConnectionID, "google_calendar")
	if err != nil {
		return composio.GoogleCalendarPage{}, errors.Join(ErrUnavailable, err)
	}
	if remoteStatus != composio.ConnectionActive {
		return composio.GoogleCalendarPage{}, ErrNotActive
	}
	identity, err := s.provider.IdentifyGoogleCalendar(ctx, connection.UpstreamConnectionID)
	if err != nil {
		return composio.GoogleCalendarPage{}, errors.Join(ErrUnavailable, err)
	}
	if connection.RemotePrincipalKey != "google_calendar:"+identity.CalendarID {
		return composio.GoogleCalendarPage{}, ErrConflict
	}
	page, err := s.provider.ListGoogleCalendars(ctx, connection.UpstreamConnectionID, pageToken, limit)
	if err != nil {
		return composio.GoogleCalendarPage{}, errors.Join(ErrUnavailable, err)
	}
	if err := s.requireCurrentSelectionConnection(ctx, accountID, connection, "google_calendar"); err != nil {
		return composio.GoogleCalendarPage{}, err
	}
	return page, nil
}

func (s *Service) requireCurrentSelectionConnection(ctx context.Context, accountID string, connection Connection, provider string) error {
	var current bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_connections WHERE id=$1 AND account_id=$2 AND provider=$3 AND status='active' AND revision=$4)`, connection.ID, accountID, provider, connection.Revision).Scan(&current)
	if err != nil {
		return err
	}
	if !current {
		return ErrStaleRevision
	}
	return nil
}
