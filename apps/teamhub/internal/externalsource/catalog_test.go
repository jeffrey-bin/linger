package externalsource

import (
	"errors"
	"reflect"
	"slices"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

var fixedAppToolkits = []struct{ key, toolkit string }{
	{"gmail", "gmail"}, {"outlook", "outlook"}, {"googledrive", "googledrive"}, {"slack", "slack"},
	{"discord", "discordbot"}, {"facebook", "facebook"}, {"github", "github"}, {"google_meet", "googlemeet"},
	{"google_calendar", "googlecalendar"}, {"notion", "notion"}, {"linear", "linear"}, {"figma", "figma"}, {"canva", "canva"},
	{"higgsfield", "higgsfield_mcp"}, {"fal_ai", "fal_ai"}, {"granola", "granola_mcp"}, {"calendly", "calendly"}, {"outlook_calendar", "outlook"},
}

func TestAppCatalogIsTheFixedListInDisplayOrder(t *testing.T) {
	service := New(nil, &composio.Client{})
	service.managed = configuredManagedCatalog(t)
	apps := service.ListApps()
	if len(apps) != len(fixedAppToolkits) {
		t.Fatalf("got %d apps, want %d", len(apps), len(fixedAppToolkits))
	}
	for index, want := range fixedAppToolkits {
		app := apps[index]
		if app.Key != want.key || toolkitForApp(app.Key) != want.toolkit || app.LogoURL != composioLogoBase+want.toolkit {
			t.Errorf("app %d = %s (%s), want %s with logo %s", index, app.Key, app.LogoURL, want.key, composioLogoBase+want.toolkit)
		}
	}
}

func TestAppAuthUsesManagedOAuthUnlessCustom(t *testing.T) {
	for _, test := range []struct {
		key, scheme string
		managed     bool
	}{{"linear", "OAUTH2", true}, {"gmail", "OAUTH2", true}, {"higgsfield", "DCR_OAUTH", false}, {"fal_ai", "API_KEY", false}, {"granola", "DCR_OAUTH", false}, {"calendly", "OAUTH2", true}, {"outlook_calendar", "OAUTH2", true}} {
		if scheme, managed := appAuth(test.key); scheme != test.scheme || managed != test.managed {
			t.Errorf("appAuth(%s) = %s %t", test.key, scheme, managed)
		}
	}
}

func TestAppCatalogWithoutComposioOffersNothing(t *testing.T) {
	service := New(nil, &composio.Client{})
	unconfigured, err := composio.New(composio.Config{EnvironmentKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	for _, managed := range []*managedCatalog{nil, {client: unconfigured}} {
		service.managed = managed
		apps := service.ListApps()
		if len(apps) != len(fixedAppToolkits) {
			t.Fatalf("got %d apps without Composio", len(apps))
		}
		for _, app := range apps {
			if app.Availability != AppAvailabilityUnavailable || len(app.Capabilities) != 0 || app.SupportsReauthorization || app.LogoURL == "" {
				t.Errorf("app %s must be unavailable but branded without Composio: %+v", app.Key, app)
			}
			if service.SupportsAgentTools(app.Key) {
				t.Errorf("app %s must not offer Agent tools without Composio", app.Key)
			}
			if _, err := service.connectionAdapter(app.Key); !errors.Is(err, ErrUnavailable) {
				t.Errorf("app %s has a connection adapter without Composio: %v", app.Key, err)
			}
		}
	}
}

func TestAppCatalogKeepsManagedAvailabilitySeparateFromImportCapabilities(t *testing.T) {
	service := New(nil, &composio.Client{})
	service.managed = configuredManagedCatalog(t)
	apps := service.ListApps()
	for _, test := range []struct {
		key                  string
		imports, reauthorize bool
	}{
		{"gmail", true, true},
		{"github", true, true},
		{"notion", true, true},
		{"facebook", false, false},
		{"linear", false, false},
		{"figma", false, false},
		{"canva", false, false},
		{"higgsfield", false, false},
		{"fal_ai", false, false},
		{"granola", false, false},
		{"calendly", false, false},
		{"outlook_calendar", false, false},
	} {
		index := slices.IndexFunc(apps, func(app ExternalApp) bool { return app.Key == test.key })
		if index < 0 {
			t.Fatalf("missing app %s", test.key)
		}
		app := apps[index]
		if app.Availability != AppAvailabilityAvailable || !slices.Contains(app.Capabilities, "connect") ||
			!slices.Contains(app.Capabilities, "agent_tools") ||
			slices.Contains(app.Capabilities, "personal_wiki_import") != test.imports ||
			app.SupportsReauthorization != test.reauthorize {
			t.Errorf("unexpected app capabilities: %+v", app)
		}
		toolApp, supported := service.agentToolsApp(test.key)
		if !supported || !reflect.DeepEqual(toolApp, app) {
			t.Errorf("agent tools disagree with catalog for %s: %+v", test.key, toolApp)
		}
		if _, err := service.connectionAdapter(test.key); err != nil {
			t.Errorf("connection adapter for %s: %v", test.key, err)
		}
	}
	// A caller cannot mutate the next catalog response.
	apps[0].Capabilities[0] = "mutated"
	for _, app := range service.ListApps() {
		if slices.Contains(app.Capabilities, "mutated") {
			t.Fatal("catalog response aliases the curated definitions")
		}
	}
}

func TestAppCatalogRejectsKeysOutsideTheFixedList(t *testing.T) {
	service := &Service{managed: configuredManagedCatalog(t)}
	for _, key := range []string{"x", "twitter", "discord_user", "discordbot", "googlecalendar", "gitlab", "hubspot", "unknown"} {
		if _, ok := service.catalogApp(key); ok {
			t.Errorf("unexpected app key %s", key)
		}
		if _, supported := service.agentToolsApp(key); supported {
			t.Errorf("unexpected agent tools app %s", key)
		}
		if _, err := service.connectionAdapter(key); !errors.Is(err, ErrUnavailable) {
			t.Errorf("unexpected adapter for %s: %v", key, err)
		}
	}
}

func TestAppCatalogMarksProactiveReminderAppsOnlyWhenConnectable(t *testing.T) {
	service := New(nil, &composio.Client{})
	service.managed = configuredManagedCatalog(t)
	for key, want := range map[string]bool{"gmail": true, "outlook": true, "notion": false, "linear": false} {
		app, ok := service.catalogApp(key)
		if !ok {
			t.Fatalf("missing app %s", key)
		}
		if slices.Contains(app.Capabilities, "proactive_reminders") != want {
			t.Errorf("%s proactive_reminders = %v, want %v: %+v", key, !want, want, app.Capabilities)
		}
	}
	service.managed = nil
	if app, _ := service.catalogApp("gmail"); slices.Contains(app.Capabilities, "proactive_reminders") {
		t.Errorf("unavailable gmail offers proactive reminders: %+v", app)
	}
}

func configuredManagedCatalog(t *testing.T) *managedCatalog {
	t.Helper()
	client, err := composio.New(composio.Config{APIKey: "test-key", EnvironmentKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	return &managedCatalog{client: client}
}

func TestUnconfiguredClientHidesManagedApps(t *testing.T) {
	client, err := composio.New(composio.Config{EnvironmentKey: "test"})
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{managed: &managedCatalog{client: client}}
	if service.ProviderConfigured() {
		t.Fatal("ProviderConfigured() = true without an API key")
	}
	if got := service.ManagedKey(); got.Source != ManagedKeySourceNone || got.CanSave {
		t.Fatalf("ManagedKey() = %+v, want none without a key box", got)
	}
	client.SetAPIKey("saved")
	if !service.ProviderConfigured() || service.ManagedKey().Source != ManagedKeySourceStored {
		t.Fatalf("a saved key is not reported: %+v", service.ManagedKey())
	}
	for _, app := range service.ListApps() {
		if app.Availability != AppAvailabilityAvailable {
			t.Fatalf("app %s is %s after a key is saved", app.Key, app.Availability)
		}
	}
}
