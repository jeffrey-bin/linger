package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type selectionDiscordProvider struct {
	fakeDiscordProvider
	pool  *pgxpool.Pool
	calls atomic.Int32
}

func (p *selectionDiscordProvider) GetConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	p.calls.Add(1)
	return composio.ConnectionActive, nil
}
func (p *selectionDiscordProvider) GetConnectionStatusForToolkit(ctx context.Context, upstreamID, _ string) (composio.ConnectionStatus, error) {
	return p.GetConnectionStatus(ctx, upstreamID)
}
func (p *selectionDiscordProvider) IdentifyDiscord(_ context.Context, upstreamID string) (composio.DiscordIdentity, error) {
	p.calls.Add(1)
	if upstreamID == "selection-discord-revoked" {
		return composio.DiscordIdentity{GuildID: "23456789012345678", GuildName: "Revoked"}, nil
	}
	return composio.DiscordIdentity{GuildID: "12345678901234567", GuildName: "TeamHub"}, nil
}
func (p *selectionDiscordProvider) ListDiscordChannels(ctx context.Context, upstreamID, _ string) ([]composio.DiscordChannel, error) {
	p.calls.Add(1)
	if upstreamID == "selection-discord-stale" {
		if _, err := p.pool.Exec(ctx, `UPDATE external_connections SET revision=revision+1 WHERE upstream_connection_id=$1`, upstreamID); err != nil {
			return nil, err
		}
	}
	return []composio.DiscordChannel{{ID: "channel-1", GuildID: "12345678901234567", Name: "product", Type: 0}}, nil
}

type selectionCalendarProvider struct {
	fakeGoogleCalendarProvider
	pool  *pgxpool.Pool
	calls atomic.Int32
}

func (p *selectionCalendarProvider) GetConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	p.calls.Add(1)
	return composio.ConnectionActive, nil
}
func (p *selectionCalendarProvider) GetConnectionStatusForToolkit(ctx context.Context, upstreamID, _ string) (composio.ConnectionStatus, error) {
	return p.GetConnectionStatus(ctx, upstreamID)
}
func (p *selectionCalendarProvider) IdentifyGoogleCalendar(_ context.Context, upstreamID string) (composio.GoogleCalendarIdentity, error) {
	p.calls.Add(1)
	if upstreamID == "selection-calendar-disconnecting" {
		return composio.GoogleCalendarIdentity{CalendarID: "disconnecting@example.test", Label: "Disconnecting", TimeZone: "Asia/Shanghai"}, nil
	}
	return composio.GoogleCalendarIdentity{CalendarID: "primary@example.test", Label: "Alice", TimeZone: "Asia/Shanghai"}, nil
}
func (p *selectionCalendarProvider) ListGoogleCalendars(ctx context.Context, upstreamID, _ string, _ int) (composio.GoogleCalendarPage, error) {
	p.calls.Add(1)
	if upstreamID == "selection-calendar-stale" {
		if _, err := p.pool.Exec(ctx, `UPDATE external_connections SET revision=revision+1 WHERE upstream_connection_id=$1`, upstreamID); err != nil {
			return composio.GoogleCalendarPage{}, err
		}
	}
	return composio.GoogleCalendarPage{Calendars: []composio.GoogleCalendar{{ID: "calendar-1", Summary: "Team", TimeZone: "Asia/Shanghai", AccessRole: "reader"}}}, nil
}

func TestAppSelectionAPIFailsClosedOnLocalAndRevisionChanges(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	discordProvider := &selectionDiscordProvider{pool: pool}
	calendarProvider := &selectionCalendarProvider{pool: pool}
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = 2 << 20
	})
	newFakeComposio(t).configure(&cfg)
	application, err := newIntegrationApp(context.Background(), cfg, withComposio(calendarAlongside{Provider: discordProvider, calendar: calendarProvider}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	if _, err = pool.Exec(context.Background(), `
		INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,remote_team_id,remote_principal_key,identity_label)
		VALUES ('selection_discord_revoked','account_alice','discord','selection-discord-revoked','revoked',1,'23456789012345678','discord:guild:23456789012345678','Discord'),
		       ('selection_calendar_disconnecting','account_alice','google_calendar','selection-calendar-disconnecting','disconnecting',1,NULL,'google_calendar:disconnecting@example.test','Calendar'),
		       ('selection_discord_stale','account_alice','discord','selection-discord-stale','active',1,'12345678901234567','discord:guild:12345678901234567','Discord'),
		       ('selection_calendar_stale','account_alice','google_calendar','selection-calendar-stale','active',1,NULL,'google_calendar:primary@example.test','Calendar')`); err != nil {
		t.Fatal(err)
	}
	assertSelectionError := func(endpoint, code, forbidden string) {
		t.Helper()
		httpStatus, _, body := env.request(alice, http.MethodGet, endpoint, nil, "")
		if httpStatus != http.StatusConflict || !strings.Contains(string(body), code) || strings.Contains(string(body), forbidden) {
			t.Fatalf("selection status=%d body=%s", httpStatus, body)
		}
	}
	assertSelectionError("/v0/external-connections/selection_discord_revoked/discord/channels", "EXTERNAL_CONNECTION_NOT_ACTIVE", "channel-1")
	assertSelectionError("/v0/external-connections/selection_calendar_disconnecting/google-calendar/calendars?limit=10", "EXTERNAL_CONNECTION_NOT_ACTIVE", "calendar-1")
	if discordProvider.calls.Load() != 0 || calendarProvider.calls.Load() != 0 {
		t.Fatalf("inactive selection provider calls discord=%d calendar=%d", discordProvider.calls.Load(), calendarProvider.calls.Load())
	}
	assertSelectionError("/v0/external-connections/selection_discord_stale/discord/channels", "STALE_REVISION", "channel-1")
	assertSelectionError("/v0/external-connections/selection_calendar_stale/google-calendar/calendars?limit=10", "STALE_REVISION", "calendar-1")
}
