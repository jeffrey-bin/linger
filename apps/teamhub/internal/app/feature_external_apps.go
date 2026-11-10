package app

import (
	"context"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// registerExternalApps builds connected apps over Composio, or over the
// provider a test injects. The Composio API key can be saved on the Apps page
// after start, so connected apps are built either way; each job and each Agent
// request checks connectedAppsConfigured when it runs.
func (a *App) registerExternalApps(ctx context.Context, cfg config.ExternalAppsConfig, injected externalsource.Provider, agentAuthorization *agentauth.Service) error {
	client, err := composio.New(composio.Config{
		BaseURL: cfg.ComposioBaseURL, APIKey: cfg.ComposioAPIKey, EnvironmentKey: cfg.ComposioEnvironmentKey,
		CallbackURL:      composio.OAuthCallbackURL(a.cfg.PublicWebURL),
		HTTPClient:       &http.Client{Timeout: config.ExternalSourceRequestTimeout},
		FetchConcurrency: config.ExternalSourceFetchConcurrency,
		MaxThreadBytes:   config.GmailImportMaxThreadBytes,
		MaxBodyBytes:     config.GmailImportMaxBodyBytes,
		MaxBatchBytes:    config.GmailImportMaxBatchBytes,
		MaxRetryAfter:    cfg.MaxRetryAfter,
	})
	if err != nil {
		return fmt.Errorf("configure Composio external sources: %w", err)
	}
	a.composioClient = client
	var provider externalsource.Provider = client
	if injected != nil {
		provider = injected
	}
	sources := externalsource.New(a.pool, provider)
	sources.SetLogger(a.logger)
	sources.SetContextProvider(client)
	sources.SetAppImportLimits(composio.AppImportLimits{
		MaxFieldBytes: config.AppImportMaxFieldBytes, MaxDocumentBytes: config.AppImportMaxDocumentBytes, MaxBatchBytes: config.AppImportMaxBatchBytes,
	})
	var keyBox *secretbox.Box
	if cfg.SecretEncryptionKey != "" {
		if keyBox, err = secretbox.New(cfg.SecretEncryptionKey); err != nil {
			return err
		}
	}
	if err = sources.ConfigureManagedApps(ctx, client, keyBox); err != nil {
		return fmt.Errorf("configure managed connected apps: %w", err)
	}
	a.externalSources = sources
	a.agentConnectedApps = agentconnectedapps.New(a.pool, agentAuthorization, sources, client)
	a.agentConnectedApps.SetLogger(a.logger)
	return nil
}

// addExternalAppJobs registers the connected app workers and sweeps, and
// AnotherMe's app listener ones when appListeners is set.
func (a *App) addExternalAppJobs(features *featureSet, appListeners bool) {
	externalsource.AddJobWorkers(features.workers, a.externalSources, a.connectedAppsConfigured)
	river.AddWorker(features.workers, &connectionAuthorizationSettleWorker{app: a})
	features.schedule(a.connectedAppSweeps(features.workers)...)
	if !appListeners {
		return
	}
	// AnotherMe's app listeners feed proactive judgement, not a direct wake.
	reminder.AddListenerJobWorkers(features.workers, a.reminders, a.composioClient, proactive.RouteListenerEvents, a.logger, a.connectedAppsConfigured)
	// The proactive service is built after the features register.
	addSweepWorker[proactiveListenerSweepArgs](features.workers, func(ctx context.Context) error {
		return a.proactive.SweepListeners(ctx)
	})
	features.schedule(
		sweepSchedule[reminder.SweepArgs](listenerSweepInterval),
		sweepSchedule[proactiveListenerSweepArgs](proactiveListenerSweepInterval),
	)
}

// connectedAppsConfigured reports whether TeamHub has a Composio API key now:
// from COMPOSIO_API_KEY, or saved on the Apps page without a restart. Agent
// prompts, CLI actions and app jobs read it at use time.
func (a *App) connectedAppsConfigured() bool {
	return a.externalSources != nil && a.externalSources.ProviderConfigured()
}

// onboardingConnections reads the Connected App accounts granted to
// AnotherMe for its onboarding status.
func (a *App) onboardingConnections(ctx context.Context, tx pgx.Tx, agentActorID, tenantID string) ([]typedcard.OnboardingConnection, error) {
	if a.externalSources == nil {
		return nil, nil
	}
	granted, err := a.externalSources.ListGrantedAgentToolConnectionsInTx(ctx, tx, agentActorID, tenantID, "", "")
	if err != nil {
		return nil, err
	}
	connections := make([]typedcard.OnboardingConnection, 0, len(granted))
	for _, connection := range granted {
		connections = append(connections, typedcard.OnboardingConnection{
			ID: connection.ID, AppName: connection.DisplayName, AccountLabel: connection.IdentityLabel,
		})
	}
	return connections, nil
}
