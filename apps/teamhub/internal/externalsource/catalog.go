package externalsource

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
)

const (
	AppAvailabilityAvailable   = "available"
	AppAvailabilityUnavailable = "unavailable"
)

type ExternalApp struct {
	Key, DisplayName, Description, Availability string
	Capabilities                                []string
	AllowsMultipleConnections                   bool
	LogoURL                                     string
	SupportsReauthorization                     bool
	// customAuthScheme names the scheme of an app whose auth config TeamHub
	// creates as custom; empty means a Composio-managed OAuth2 config.
	customAuthScheme string
}

type connectionIdentity struct {
	Label, PrincipalKey                  string
	RemoteTeamID, RemoteTeamName, UserID string
}

// All applications share the same Composio connection lifecycle. Only the
// identity lookup depends on the application.
type connectionAdapter struct {
	client   *composio.Client
	toolkit  string
	identify func(context.Context, string) (connectionIdentity, error)
}

func (a connectionAdapter) Status(ctx context.Context, upstreamID string) (composio.ConnectionStatus, error) {
	return a.client.GetConnectionStatusForToolkit(ctx, upstreamID, a.toolkit)
}

func (a connectionAdapter) Identify(ctx context.Context, upstreamID string, status composio.ConnectionStatus) (connectionIdentity, error) {
	if status != composio.ConnectionActive {
		return connectionIdentity{}, nil
	}
	return a.identify(ctx, upstreamID)
}

func (a connectionAdapter) Revoke(ctx context.Context, upstreamID string) error {
	return a.client.RevokeConnection(ctx, upstreamID)
}

func (s *Service) identifyGmail(ctx context.Context, upstreamID string) (connectionIdentity, error) {
	identity, err := s.provider.IdentifyGmail(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	email := strings.ToLower(strings.TrimSpace(identity.EmailAddress))
	if email == "" {
		return connectionIdentity{}, ErrInvalid
	}
	return connectionIdentity{Label: email, PrincipalKey: "gmail:" + email}, nil
}

func (s *Service) identifyOutlook(ctx context.Context, upstreamID string) (connectionIdentity, error) {
	identity, err := s.provider.IdentifyOutlook(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	return connectionIdentity{Label: strings.ToLower(strings.TrimSpace(identity.Label)), PrincipalKey: "outlook:" + identity.ID}, nil
}

func (s *Service) identifySlack(ctx context.Context, upstreamID string) (connectionIdentity, error) {
	identity, err := s.provider.IdentifySlack(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	if identity.TeamID == "" || identity.UserID == "" || identity.TeamName == "" {
		return connectionIdentity{}, ErrInvalid
	}
	return connectionIdentity{
		Label: identity.TeamName, PrincipalKey: "slack:" + identity.TeamID + ":" + identity.UserID,
		RemoteTeamID: identity.TeamID, RemoteTeamName: identity.TeamName, UserID: identity.UserID,
	}, nil
}

func (s *Service) identifyDiscord(ctx context.Context, upstreamID string) (connectionIdentity, error) {
	identity, err := s.provider.IdentifyDiscord(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	if identity.GuildID == "" || strings.TrimSpace(identity.GuildName) == "" {
		return connectionIdentity{}, ErrInvalid
	}
	return connectionIdentity{
		Label: strings.TrimSpace(identity.GuildName), PrincipalKey: "discord:guild:" + identity.GuildID,
		RemoteTeamID: identity.GuildID, RemoteTeamName: strings.TrimSpace(identity.GuildName),
	}, nil
}
func (s *Service) identifyGitHub(ctx context.Context, upstreamID string) (connectionIdentity, error) {
	identity, err := s.provider.IdentifyGitHub(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	if identity.UserID == "" || strings.TrimSpace(identity.Login) == "" {
		return connectionIdentity{}, ErrInvalid
	}
	return connectionIdentity{Label: "@" + strings.TrimSpace(identity.Login), PrincipalKey: "github:" + identity.UserID}, nil
}
func (s *Service) identifyNotion(ctx context.Context, upstreamID string) (connectionIdentity, error) {
	identity, err := s.provider.IdentifyNotion(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	if identity.BotID == "" {
		return connectionIdentity{}, ErrInvalid
	}
	label := strings.TrimSpace(identity.WorkspaceName)
	if label == "" {
		label = "Notion"
	}
	return connectionIdentity{Label: label, PrincipalKey: "notion:" + identity.BotID}, nil
}
func (s *Service) identifyGoogleCalendar(ctx context.Context, upstreamID string) (connectionIdentity, error) {
	identity, err := s.provider.IdentifyGoogleCalendar(ctx, upstreamID)
	if err != nil {
		return connectionIdentity{}, err
	}
	if identity.CalendarID == "" || strings.TrimSpace(identity.Label) == "" {
		return connectionIdentity{}, ErrInvalid
	}
	return connectionIdentity{Label: strings.TrimSpace(identity.Label), PrincipalKey: "google_calendar:" + identity.CalendarID}, nil
}

// composioLogoBase serves each provider toolkit's logo by its slug.
const composioLogoBase = "https://logos.composio.dev/api/"

// curatedApps is the complete, fixed list of connectable apps and their display
// order. TeamHub creates each app's auth config in Composio on first use.
var curatedApps = []ExternalApp{
	{Key: "gmail", DisplayName: "Gmail", Description: "Import the last six months, up to 3,000 messages, for Profile and Wiki.", Capabilities: []string{"connect", "personal_wiki_import", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "outlook", DisplayName: "Outlook Mail", Description: "Import the last six months, up to 3,000 messages, for Profile and Wiki.", Capabilities: []string{"connect", "personal_wiki_import", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "googledrive", DisplayName: "Google Drive", Description: "Let Agents work with your Drive files.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "slack", DisplayName: "Slack", Description: "Connect workspaces and selected channels.", Capabilities: []string{"connect", "personal_wiki_import", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "discord", DisplayName: "Discord", Description: "Connect one installed Discord server and selected channels.", Capabilities: []string{"connect", "personal_wiki_import", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "facebook", DisplayName: "Facebook", Description: "Connect supported Facebook content.", AllowsMultipleConnections: true},
	{Key: "github", DisplayName: "GitHub", Description: "Import a public profile and selected owned repositories, and let authorized Agents read repositories, issues, and pull requests.", Capabilities: []string{"connect", "personal_wiki_import"}, AllowsMultipleConnections: true},
	{Key: "google_meet", DisplayName: "Google Meet", Description: "Connect available Google Meet records.", AllowsMultipleConnections: true},
	{Key: "google_calendar", DisplayName: "Google Calendar", Description: "Connect calendars and import selected events.", Capabilities: []string{"connect", "personal_wiki_import", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "notion", DisplayName: "Notion", Description: "Connect Notion to generate your profile and let authorized Agents use shared pages and databases.", Capabilities: []string{"connect", "personal_wiki_import", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "linear", DisplayName: "Linear", Description: "Let Agents work with your Linear issues and projects.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "figma", DisplayName: "Figma", Description: "Let Agents work with your Figma files.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "canva", DisplayName: "Canva", Description: "Let Agents work with your Canva designs.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "higgsfield", DisplayName: "Higgsfield", Description: "Let Agents generate images and videos with Higgsfield.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true, customAuthScheme: "DCR_OAUTH"},
	{Key: "fal_ai", DisplayName: "fal.ai", Description: "Let Agents run generative media models on fal.ai.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true, customAuthScheme: "API_KEY"},
	{Key: "granola", DisplayName: "Granola", Description: "Let Agents read your Granola meeting notes and transcripts.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true, customAuthScheme: "DCR_OAUTH"},
	{Key: "calendly", DisplayName: "Calendly", Description: "Let Agents work with your Calendly event types and scheduled events.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true},
	{Key: "outlook_calendar", DisplayName: "Outlook Calendar", Description: "Let Agents work with your Outlook calendars and events.", Capabilities: []string{"connect", "agent_tools"}, AllowsMultipleConnections: true},
}

// ProviderConfigured reports whether a connection provider backs the catalog.
// Without one, every app stays unavailable.
func (s *Service) ProviderConfigured() bool {
	return s.managed != nil && s.managed.client.Configured()
}

func (s *Service) ListApps() []ExternalApp {
	apps := make([]ExternalApp, 0, len(curatedApps))
	for _, definition := range curatedApps {
		app, _ := s.catalogApp(definition.Key)
		apps = append(apps, app)
	}
	return apps
}

// catalogApp projects one curated app. An app is available only while a
// Composio API key is configured; otherwise it offers nothing an Agent could
// request.
func (s *Service) catalogApp(appKey string) (ExternalApp, bool) {
	index := slices.IndexFunc(curatedApps, func(app ExternalApp) bool { return app.Key == appKey })
	if index < 0 {
		return ExternalApp{}, false
	}
	definition := curatedApps[index]
	app := definition
	app.LogoURL = composioLogoBase + toolkitForApp(app.Key)
	app.Availability = AppAvailabilityUnavailable
	app.Capabilities = []string{}
	if s.ProviderConfigured() {
		app.Availability = AppAvailabilityAvailable
		app.Capabilities = []string{"connect", "agent_tools"}
		// Wiki import and trusted reauthorization need a confirmed account identity.
		if s.appIdentity(app.Key) != nil {
			app.SupportsReauthorization = true
			if slices.Contains(definition.Capabilities, "personal_wiki_import") {
				app.Capabilities = append(app.Capabilities, "personal_wiki_import")
			}
		}
	}
	return withProactiveReminders(app), true
}

// withProactiveReminders marks a connectable app AnotherMe can watch for
// things that need the Human's attention.
func withProactiveReminders(app ExternalApp) ExternalApp {
	if slices.Contains(app.Capabilities, "connect") && proactive.IsListenerProvider(app.Key) {
		app.Capabilities = append(slices.Clone(app.Capabilities), "proactive_reminders")
	}
	return app
}

// appIdentity returns the identity lookup of an application whose account
// identity TeamHub confirms, or nil when the application uses a generic identity.
func (s *Service) appIdentity(appKey string) func(context.Context, string) (connectionIdentity, error) {
	switch appKey {
	case "googledrive":
		if s.contextProvider != nil {
			return func(ctx context.Context, id string) (connectionIdentity, error) {
				identity, err := s.contextProvider.IdentifyGoogleDrive(ctx, id)
				return connectionIdentity{Label: identity.Label, PrincipalKey: "googledrive:" + identity.ID}, err
			}
		}
	case "gmail":
		if s.provider != nil {
			return s.identifyGmail
		}
	case "outlook":
		if s.provider != nil {
			return s.identifyOutlook
		}
	case "slack":
		if s.provider != nil {
			return s.identifySlack
		}
	case "discord":
		if s.provider != nil {
			return s.identifyDiscord
		}
	case "github":
		if s.provider != nil {
			return s.identifyGitHub
		}
	case "notion":
		if s.provider != nil {
			return s.identifyNotion
		}
	case "google_calendar":
		if s.provider != nil {
			return s.identifyGoogleCalendar
		}
	}
	return nil
}

func (s *Service) connectionAdapter(appKey string) (connectionAdapter, error) {
	app, ok := s.catalogApp(appKey)
	if !ok || !s.ProviderConfigured() {
		return connectionAdapter{}, ErrUnavailable
	}
	identify := s.appIdentity(appKey)
	if identify == nil {
		// Generic identities cannot inherit an old account's grants.
		identify = func(_ context.Context, id string) (connectionIdentity, error) {
			return connectionIdentity{Label: app.DisplayName + " account", PrincipalKey: "composio:" + id}, nil
		}
	}
	return connectionAdapter{client: s.managed.client, toolkit: toolkitForApp(appKey), identify: identify}, nil
}

func (s *Service) agentToolsApp(appKey string) (ExternalApp, bool) {
	app, ok := s.catalogApp(appKey)
	if !ok || app.Availability != AppAvailabilityAvailable || !slices.Contains(app.Capabilities, "agent_tools") {
		return ExternalApp{}, false
	}
	return app, true
}

func mapConnectionAdapterError(err error) error {
	if errors.Is(err, ErrInvalid) {
		return err
	}
	return errors.Join(ErrUnavailable, err)
}
