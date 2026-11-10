package integration_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

// Fake External Source providers and seeds shared by the connection, mail
// import and Personal Profile tests.

var (
	recentAppImportFixtureTime = time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
	oldAppImportFixtureTime    = recentAppImportFixtureTime.AddDate(0, 0, -30)
)

func appImportFixtureCalendarTimes() (string, string) {
	start := recentAppImportFixtureTime.In(time.FixedZone("Asia/Shanghai", 8*60*60))
	return start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339)
}

type fakeDiscordProvider struct {
	// Provider panics on the apps this fake does not serve.
	externalsource.Provider
	archivedCalls   *atomic.Int32
	windowedArchive bool
}

func (fakeDiscordProvider) GetConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}
func (fakeDiscordProvider) GetConnectionStatusForToolkit(context.Context, string, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}
func (fakeDiscordProvider) IdentifyDiscord(context.Context, string) (composio.DiscordIdentity, error) {
	return composio.DiscordIdentity{GuildID: "12345678901234567", GuildName: "TeamHub"}, nil
}
func (fakeDiscordProvider) GetDiscordGuild(context.Context, string, string) (composio.DiscordIdentity, error) {
	return composio.DiscordIdentity{GuildID: "12345678901234567", GuildName: "TeamHub"}, nil
}
func (fakeDiscordProvider) ListDiscordChannels(context.Context, string, string) ([]composio.DiscordChannel, error) {
	return []composio.DiscordChannel{{ID: "channel-1", GuildID: "12345678901234567", Name: "product", Type: 0}}, nil
}
func (fakeDiscordProvider) ListDiscordActiveThreads(context.Context, string, string) ([]composio.DiscordChannel, error) {
	return []composio.DiscordChannel{{ID: "thread-1", GuildID: "12345678901234567", ParentID: "channel-1", Name: "launch", Type: 11}}, nil
}
func (p fakeDiscordProvider) ListDiscordArchivedThreads(context.Context, string, string, string, string, int) (composio.DiscordThreadPage, error) {
	if p.archivedCalls != nil {
		p.archivedCalls.Add(1)
	}
	if p.windowedArchive {
		return composio.DiscordThreadPage{
			Threads: []composio.DiscordChannel{
				{ID: "thread-recent", GuildID: "12345678901234567", ParentID: "channel-1", Name: "recent", Type: 11, ArchivedAt: recentAppImportFixtureTime},
				{ID: "thread-old", GuildID: "12345678901234567", ParentID: "channel-1", Name: "old", Type: 11, ArchivedAt: oldAppImportFixtureTime},
			},
			NextCursor: oldAppImportFixtureTime.Format(time.RFC3339),
		}, nil
	}
	return composio.DiscordThreadPage{}, nil
}
func (fakeDiscordProvider) ListDiscordMessages(_ context.Context, _ string, channelID, before string, _ int) (composio.DiscordMessagePage, error) {
	if before != "" {
		return composio.DiscordMessagePage{}, nil
	}
	return composio.DiscordMessagePage{Messages: []composio.DiscordMessage{{ID: channelID + "-message", ChannelID: channelID, Content: "Imported message", AuthorID: "user-1", AuthorName: "Alice", Timestamp: recentAppImportFixtureTime}}}, nil
}

type fakeGoogleCalendarProvider struct {
	// Provider panics on the apps this fake does not serve.
	externalsource.Provider
}

func (fakeGoogleCalendarProvider) GetConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}
func (fakeGoogleCalendarProvider) GetConnectionStatusForToolkit(context.Context, string, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}
func (fakeGoogleCalendarProvider) IdentifyGoogleCalendar(context.Context, string) (composio.GoogleCalendarIdentity, error) {
	return composio.GoogleCalendarIdentity{CalendarID: "primary@example.test", Label: "Alice", TimeZone: "Asia/Shanghai"}, nil
}
func (fakeGoogleCalendarProvider) ListGoogleCalendars(_ context.Context, _ string, pageToken string, _ int) (composio.GoogleCalendarPage, error) {
	if pageToken == "" {
		return composio.GoogleCalendarPage{Calendars: []composio.GoogleCalendar{{ID: "team@example.test", Summary: "Team", TimeZone: "Asia/Shanghai", AccessRole: "reader", Selected: true}}, NextPageToken: "calendar-page-2"}, nil
	}
	if pageToken == "calendar-page-2" {
		return composio.GoogleCalendarPage{Calendars: []composio.GoogleCalendar{{ID: "teamexampletest", Summary: "Team", TimeZone: "Asia/Shanghai", AccessRole: "reader", Selected: true}}}, nil
	}
	return composio.GoogleCalendarPage{}, nil
}
func (fakeGoogleCalendarProvider) ListGoogleCalendarEvents(_ context.Context, _ string, calendarID, pageToken string, _, _ time.Time, _ int) (composio.GoogleCalendarEventPage, error) {
	if pageToken == "" {
		start, end := appImportFixtureCalendarTimes()
		return composio.GoogleCalendarEventPage{Events: []composio.GoogleCalendarEvent{{ID: calendarID + "-event", Status: "confirmed", Summary: "Planning", StartDateTime: start, StartTimeZone: "Asia/Shanghai", EndDateTime: end, EndTimeZone: "Asia/Shanghai", Creator: composio.GoogleCalendarPerson{Email: "creator@example.test"}, Organizer: composio.GoogleCalendarPerson{Email: "owner@example.test"}, Attendees: []composio.GoogleCalendarPerson{{Email: "guest@example.test", ResponseStatus: "accepted"}}}}, NextPageToken: "event-page-2"}, nil
	}
	return composio.GoogleCalendarEventPage{}, nil
}

type fakeGmailProvider struct {
	// Provider panics on the apps this fake does not serve.
	externalsource.Provider
	mu            sync.Mutex
	status        composio.ConnectionStatus
	statuses      map[string]composio.ConnectionStatus
	mail          []composio.AppDocument
	identityEmail string
	identityErrs  map[string]error
	identityStart map[string]chan struct{}
	identityDone  map[string]chan struct{}
	identityWait  map[string]chan struct{}
	fetchCalls    int
}

func (p *fakeGmailProvider) IdentifyGmail(ctx context.Context, upstreamID string) (composio.GmailIdentity, error) {
	p.mu.Lock()
	email := p.identityEmail
	identityErr := p.identityErrs[upstreamID]
	started := p.identityStart[upstreamID]
	done := p.identityDone[upstreamID]
	wait := p.identityWait[upstreamID]
	p.mu.Unlock()
	if email == "" {
		email = "alice@example.test"
	}
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if done != nil {
		defer func() {
			select {
			case done <- struct{}{}:
			default:
			}
		}()
	}
	if wait != nil {
		select {
		case <-ctx.Done():
			return composio.GmailIdentity{}, ctx.Err()
		case <-wait:
		}
	}
	if identityErr != nil {
		return composio.GmailIdentity{}, identityErr
	}
	return composio.GmailIdentity{EmailAddress: email, HistoryID: "history_1"}, nil
}

func (p *fakeGmailProvider) GetConnectionStatus(_ context.Context, upstreamID string) (composio.ConnectionStatus, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if status, ok := p.statuses[upstreamID]; ok {
		return status, nil
	}
	return p.status, nil
}

// FetchMailImportPage serves the whole fake mailbox as one page.
func (p *fakeGmailProvider) FetchMailImportPage(context.Context, string, string, composio.MailImportPageOptions) (composio.MailImportPage, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.fetchCalls++
	page := composio.MailImportPage{Read: len(p.mail)}
	for _, document := range p.mail {
		// Like renderImportedMail, plain human mail carries a Profile view of
		// its whole body.
		if len(document.ProfileMarkdown) == 0 {
			document.ProfileMarkdown = document.Markdown
		}
		page.Documents = append(page.Documents, document)
	}
	return page, nil
}

func (p *fakeGmailProvider) FetchCalls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.fetchCalls
}

type fakeSlackProvider struct {
	// Provider panics on the apps this fake does not serve.
	externalsource.Provider
	mu          sync.Mutex
	status      composio.ConnectionStatus
	documents   []composio.SlackDocument
	fetchErr    error
	listStarted chan struct{}
	listRelease chan struct{}
}

func (p *fakeSlackProvider) GetConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.status, nil
}
func (p *fakeSlackProvider) IdentifySlack(context.Context, string) (composio.SlackIdentity, error) {
	return composio.SlackIdentity{TeamID: "T1", TeamName: "Test", TeamDomain: "test", UserID: "U1"}, nil
}
func (p *fakeSlackProvider) ListSlackConversations(ctx context.Context, _ string, _ string, _ int) (composio.SlackConversationPage, error) {
	p.mu.Lock()
	started, release := p.listStarted, p.listRelease
	p.mu.Unlock()
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return composio.SlackConversationPage{}, ctx.Err()
		}
	}
	return composio.SlackConversationPage{Conversations: []composio.SlackConversation{{ID: "C1", Name: "public", Kind: "public_channel"}, {ID: "G1", Name: "private", Kind: "private_channel", IsPrivate: true}, {ID: "D1", Name: "dm", Kind: "im"}, {ID: "M1", Name: "group", Kind: "mpim"}}}, nil
}
func (p *fakeSlackProvider) FetchSlackDocuments(context.Context, string, composio.SlackIdentity, []composio.SlackConversation, composio.SlackImportOptions) ([]composio.SlackDocument, int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.fetchErr != nil {
		return nil, 2, p.fetchErr
	}
	return append([]composio.SlackDocument(nil), p.documents...), 2, nil
}

func waitForExternalSource(condition func() bool) bool {
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func aliceAccountID(t *testing.T, ctx context.Context, pool *pgxpool.Pool) string {
	t.Helper()
	var accountID string
	if err := pool.QueryRow(ctx, `SELECT account_id FROM actors WHERE id='actor_acme_alice'`).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	return accountID
}

func seedExternalConnection(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, accountID, provider, connectionStatus string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,identity_label,remote_principal_key) VALUES($1,$2,$3,$1||'-upstream',$4,$1,$1||'-principal')`, id, accountID, provider, connectionStatus); err != nil {
		t.Fatal(err)
	}
}

type emptyGoogleCalendarProvider struct{ fakeGoogleCalendarProvider }

func (emptyGoogleCalendarProvider) ListGoogleCalendarEvents(context.Context, string, string, string, time.Time, time.Time, int) (composio.GoogleCalendarEventPage, error) {
	return composio.GoogleCalendarEventPage{}, nil
}

// calendarAlongside serves Google Calendar from calendar and every other app,
// connection status included, from Provider.
type calendarAlongside struct {
	externalsource.Provider
	calendar externalsource.Provider
}

func (p calendarAlongside) IdentifyGoogleCalendar(ctx context.Context, upstreamID string) (composio.GoogleCalendarIdentity, error) {
	return p.calendar.IdentifyGoogleCalendar(ctx, upstreamID)
}

func (p calendarAlongside) ListGoogleCalendars(ctx context.Context, upstreamID, cursor string, limit int) (composio.GoogleCalendarPage, error) {
	return p.calendar.ListGoogleCalendars(ctx, upstreamID, cursor, limit)
}

func (p calendarAlongside) ListGoogleCalendarEvents(ctx context.Context, upstreamID, calendarID, cursor string, start, end time.Time, limit int) (composio.GoogleCalendarEventPage, error) {
	return p.calendar.ListGoogleCalendarEvents(ctx, upstreamID, calendarID, cursor, start, end, limit)
}

// gmailAndSlack serves Slack from slack and every other app, connection status
// and mail identity and import included, from the Gmail fake.
type gmailAndSlack struct {
	*fakeGmailProvider
	slack *fakeSlackProvider
}

func (p gmailAndSlack) IdentifySlack(ctx context.Context, upstreamID string) (composio.SlackIdentity, error) {
	return p.slack.IdentifySlack(ctx, upstreamID)
}

func (p gmailAndSlack) ListSlackConversations(ctx context.Context, upstreamID, cursor string, limit int) (composio.SlackConversationPage, error) {
	return p.slack.ListSlackConversations(ctx, upstreamID, cursor, limit)
}

func (p gmailAndSlack) FetchSlackDocuments(ctx context.Context, upstreamID string, identity composio.SlackIdentity, conversations []composio.SlackConversation, options composio.SlackImportOptions) ([]composio.SlackDocument, int, error) {
	return p.slack.FetchSlackDocuments(ctx, upstreamID, identity, conversations, options)
}
