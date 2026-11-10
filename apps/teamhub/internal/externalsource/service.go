// Package externalsource owns external connection identity, ownership, and deterministic imports.
package externalsource

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	ErrInvalid     = errors.New("invalid external source request")
	ErrNotFound    = errors.New("external connection not found")
	ErrNotActive   = errors.New("external connection is not active")
	ErrUnavailable = errors.New("external source provider is unavailable")
	ErrConflict    = errors.New("external source request conflicts with current state")
)

// Provider is the Composio surface connected apps import through: connection
// status, account identity, mail import and the read calls of Slack, Discord,
// GitHub, Notion and Google Calendar.
type Provider interface {
	GetConnectionStatus(context.Context, string) (composio.ConnectionStatus, error)
	// GetConnectionStatusForToolkit checks a connection that Composio files
	// under a toolkit other than the app's own key.
	GetConnectionStatusForToolkit(context.Context, string, string) (composio.ConnectionStatus, error)
	IdentifyGmail(context.Context, string) (composio.GmailIdentity, error)
	IdentifyOutlook(context.Context, string) (composio.OutlookIdentity, error)
	FetchMailImportPage(context.Context, string, string, composio.MailImportPageOptions) (composio.MailImportPage, error)
	IdentifySlack(context.Context, string) (composio.SlackIdentity, error)
	ListSlackConversations(context.Context, string, string, int) (composio.SlackConversationPage, error)
	FetchSlackDocuments(context.Context, string, composio.SlackIdentity, []composio.SlackConversation, composio.SlackImportOptions) ([]composio.SlackDocument, int, error)
	IdentifyDiscord(context.Context, string) (composio.DiscordIdentity, error)
	GetDiscordGuild(context.Context, string, string) (composio.DiscordIdentity, error)
	ListDiscordChannels(context.Context, string, string) ([]composio.DiscordChannel, error)
	ListDiscordActiveThreads(context.Context, string, string) ([]composio.DiscordChannel, error)
	ListDiscordArchivedThreads(context.Context, string, string, string, string, int) (composio.DiscordThreadPage, error)
	ListDiscordMessages(context.Context, string, string, string, int) (composio.DiscordMessagePage, error)
	IdentifyGitHub(context.Context, string) (composio.GitHubIdentity, error)
	ListGitHubRepositories(context.Context, string, composio.GitHubIdentity, string, int) (composio.GitHubRepositoryPage, error)
	GetGitHubReadme(context.Context, string, composio.GitHubRepository) (*composio.GitHubReadme, error)
	IdentifyNotion(context.Context, string) (composio.NotionIdentity, error)
	ListNotionResources(context.Context, string, string, int) (composio.NotionResourcePage, error)
	GetNotionPage(context.Context, string, composio.NotionResource) (composio.NotionSnapshot, error)
	GetNotionDatabase(context.Context, string, composio.NotionResource) (composio.NotionSnapshot, error)
	IdentifyGoogleCalendar(context.Context, string) (composio.GoogleCalendarIdentity, error)
	ListGoogleCalendars(context.Context, string, string, int) (composio.GoogleCalendarPage, error)
	ListGoogleCalendarEvents(context.Context, string, string, string, time.Time, time.Time, int) (composio.GoogleCalendarEventPage, error)
}

type Service struct {
	managed             *managedCatalog
	pool                *pgxpool.Pool
	provider            Provider
	contextProvider     *composio.Client
	appImportLimits     composio.AppImportLimits
	logger              *slog.Logger
	writeMailWikiSource func(context.Context, MailWikiSource) error
	mailImported        func(context.Context, pgx.Tx, MailImported) error
}

type Connection struct {
	ID                   string
	AccountID            string
	Provider             string
	UpstreamConnectionID string
	Status               string
	ConnectURL           string
	ConnectExpiresAt     *time.Time
	CreatedAt            time.Time
	UpdatedAt            time.Time
	RemoteTeamID         string
	RemoteTeamName       string
	RemoteUserID         string
	RemotePrincipalKey   string
	IdentityLabel        string
	Revision             int64
	StatusCheckedAt      *time.Time
	StatusErrorCode      string
	AutoReminders        bool
	// StatusCheckRequestedAt is set while a check the user asked for waits
	// for the reconcile to write its result.
	StatusCheckRequestedAt *time.Time
	// Reauthorization* describe a reauthorization in progress: its candidate
	// upstream and Connect Link. ReauthorizationErrorCode is how the last one
	// failed.
	ReauthorizationUpstreamID       string
	ReauthorizationConnectURL       string
	ReauthorizationConnectExpiresAt *time.Time
	ReauthorizationErrorCode        string
}

// New builds the service over provider, which is nil where connected apps
// cannot import.
func New(pool *pgxpool.Pool, provider Provider) *Service {
	return &Service{pool: pool, provider: provider, appImportLimits: composio.DefaultAppImportLimits(), logger: slog.Default()}
}

func (s *Service) SetLogger(logger *slog.Logger) {
	if logger != nil {
		s.logger = logger
	}
}

func (s *Service) SetContextProvider(provider *composio.Client) { s.contextProvider = provider }

func (s *Service) SetAppImportLimits(limits composio.AppImportLimits) {
	s.appImportLimits = composio.NormalizeAppImportLimits(limits)
}

func (s *Service) ListSlackConversations(ctx context.Context, accountID, connectionID, cursor string, limit int) (composio.SlackConversationPage, error) {
	if s.provider == nil {
		return composio.SlackConversationPage{}, ErrUnavailable
	}
	connection, err := s.loadProviderConnection(ctx, accountID, connectionID, "slack")
	if err != nil {
		return composio.SlackConversationPage{}, err
	}
	status, err := s.provider.GetConnectionStatus(ctx, connection.UpstreamConnectionID)
	if err != nil {
		return composio.SlackConversationPage{}, errors.Join(ErrUnavailable, err)
	}
	if status != composio.ConnectionActive {
		return composio.SlackConversationPage{}, ErrNotActive
	}
	if current, currentErr := s.loadConnection(ctx, accountID, connectionID); currentErr != nil || current.Revision != connection.Revision || current.Status == "disconnecting" || current.Status == "revoke_pending" || current.Status == "revoked" {
		return composio.SlackConversationPage{}, ErrStaleRevision
	}
	identity, err := s.provider.IdentifySlack(ctx, connection.UpstreamConnectionID)
	if err != nil {
		return composio.SlackConversationPage{}, errors.Join(ErrUnavailable, err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return composio.SlackConversationPage{}, err
	}
	defer tx.Rollback(ctx)
	updated, err := tx.Exec(ctx, `UPDATE external_connections SET status='active',active_since=coalesce(active_since,now()),remote_team_id=$2,remote_team_name=$3,remote_user_id=$4,identity_label=$3,status_checked_at=now(),connect_url=NULL,status_error_code=NULL,updated_at=now() WHERE id=$1 AND revision=$5 AND status NOT IN ('disconnecting','revoke_pending','revoked')`, connection.ID, identity.TeamID, identity.TeamName, identity.UserID, connection.Revision)
	if err != nil {
		return composio.SlackConversationPage{}, mapDatabaseError(err)
	}
	if updated.RowsAffected() != 1 {
		return composio.SlackConversationPage{}, ErrStaleRevision
	}
	if err = s.connectionActivatedTx(ctx, tx, accountID, connection.ID, connection.Status); err != nil {
		return composio.SlackConversationPage{}, err
	}
	changed := connection.Status != "active" || connection.StatusErrorCode != "" ||
		connection.RemoteTeamID != identity.TeamID || connection.RemoteTeamName != identity.TeamName ||
		connection.RemoteUserID != identity.UserID || connection.IdentityLabel != identity.TeamName
	if changed {
		err = s.commitAccountExternalConnectionsChange(ctx, tx, accountID)
	} else {
		err = tx.Commit(ctx)
	}
	if err != nil {
		return composio.SlackConversationPage{}, err
	}
	if current, currentErr := s.loadConnection(ctx, accountID, connectionID); currentErr != nil || current.Revision != connection.Revision || current.Status != "active" {
		return composio.SlackConversationPage{}, ErrStaleRevision
	}
	page, err := s.provider.ListSlackConversations(ctx, connection.UpstreamConnectionID, cursor, limit)
	if err != nil {
		return composio.SlackConversationPage{}, errors.Join(ErrUnavailable, err)
	}
	if current, currentErr := s.loadConnection(ctx, accountID, connectionID); currentErr != nil || current.Revision != connection.Revision || current.Status != "active" {
		return composio.SlackConversationPage{}, ErrStaleRevision
	}
	return page, nil
}

// CreateConnection starts an authorization. A Gmail or Outlook connection
// also queues its mailbox import into the Account's Tenant. Each call starts
// a new Connection.
func (s *Service) CreateConnection(ctx context.Context, accountID, appKey string) (Connection, error) {
	if accountID == "" || !composio.ValidAppKey(appKey) {
		return Connection{}, ErrInvalid
	}
	importTenantID := ""
	if IsMailProvider(appKey) {
		tenantID, err := accountSpaceID(ctx, s.pool, accountID)
		if err != nil {
			return Connection{}, err
		}
		importTenantID = tenantID
	}
	app, exists := s.catalogApp(appKey)
	if !exists || app.Availability != AppAvailabilityAvailable {
		return Connection{}, ErrUnavailable
	}
	adapter, err := s.connectionAdapter(appKey)
	if err != nil {
		return Connection{}, err
	}
	// Resolve the shared Auth Config before pinning a connection transaction.
	// The transaction then serializes retries without nested pool acquisition.
	managedConfigID, err := s.ensureAuthConfig(ctx, appKey)
	if err != nil {
		return Connection{}, classifyConnectionAuthError(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connection{}, err
	}
	defer tx.Rollback(ctx)
	link, err := s.createManagedLinkInTx(ctx, tx, accountID, adapter.toolkit, managedConfigID)
	if err != nil {
		return Connection{}, classifyConnectionAuthError(mapConnectionAdapterError(err))
	}
	connection := Connection{
		ID: idgen.New("external_connection"), AccountID: accountID, Provider: appKey,
		UpstreamConnectionID: link.ConnectedAccountID, Status: "pending",
		ConnectURL: link.RedirectURL, ConnectExpiresAt: &link.ExpiresAt, IdentityLabel: app.DisplayName + " account", Revision: 1,
	}
	// The user is only now opening the Connect Link. Its first check is queued
	// here and repeats quickly while the user authorizes; a returning OAuth
	// popup checks it at once.
	err = tx.QueryRow(ctx, `
		INSERT INTO external_connections(
			id,account_id,provider,upstream_connection_id,status,connect_expires_at,connect_url,identity_label,toolkit_slug,auth_config_id,next_status_check_at
		) VALUES($1,$2,$3,$4,'pending',$5,$6,nullif($7,''),$8,nullif($9,''),now()+$10::interval)
		RETURNING created_at,updated_at`,
		connection.ID, connection.AccountID, connection.Provider, connection.UpstreamConnectionID,
		link.ExpiresAt, connection.ConnectURL, connection.IdentityLabel, adapter.toolkit, link.AuthConfigID, durationInterval(connectingPoll),
	).Scan(&connection.CreatedAt, &connection.UpdatedAt)
	if err != nil {
		return Connection{}, mapDatabaseError(err)
	}
	if err = jobs.InsertTx(ctx, tx, ConnectionReconcileArgs{ConnectionID: connection.ID}, &river.InsertOpts{ScheduledAt: time.Now().Add(connectingPoll)}); err != nil {
		return Connection{}, err
	}
	if importTenantID != "" {
		if err = jobs.InsertTx(ctx, tx, MailConnectionArgs{AccountID: accountID, TenantID: importTenantID, ConnectionID: connection.ID}, nil); err != nil {
			return Connection{}, err
		}
	}
	if err = s.commitAccountExternalConnectionsChange(ctx, tx, accountID); err != nil {
		return Connection{}, err
	}
	return connection, nil
}

// accountSpaceID returns the Space of the Account's single Human Actor.
func accountSpaceID(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, accountID string) (string, error) {
	var tenantID string
	err := db.QueryRow(ctx, `SELECT tenant_id FROM actors WHERE account_id=$1 AND kind='human'`, accountID).Scan(&tenantID)
	return tenantID, err
}

func (s *Service) GetConnection(ctx context.Context, accountID, connectionID string) (Connection, error) {
	return s.loadConnection(ctx, accountID, connectionID)
}

// SetAutoRemindersInTx records whether AnotherMe watches this Account-owned
// connection for things that need the Human's attention. It returns ErrInvalid
// for a provider AnotherMe cannot watch.
func (s *Service) SetAutoRemindersInTx(ctx context.Context, tx pgx.Tx, accountID, connectionID string, enabled bool) error {
	var provider string
	err := tx.QueryRow(ctx, `
		SELECT provider FROM external_connections
		WHERE id=$1 AND account_id=$2
		FOR UPDATE`, connectionID, accountID).Scan(&provider)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !proactive.IsListenerProvider(provider) {
		return ErrInvalid
	}
	_, err = tx.Exec(ctx, `UPDATE external_connections SET auto_reminders=$2,updated_at=now() WHERE id=$1 AND auto_reminders<>$2`, connectionID, enabled)
	return err
}

func (s *Service) connectionStatus(ctx context.Context, connection Connection) (composio.ConnectionStatus, error) {
	adapter, err := s.connectionAdapter(connection.Provider)
	if err != nil {
		return "", err
	}
	return adapter.Status(ctx, connection.UpstreamConnectionID)
}

func (s *Service) loadConnection(ctx context.Context, accountID, connectionID string) (Connection, error) {
	var connection Connection
	err := s.pool.QueryRow(ctx, `
		SELECT id,account_id,provider,upstream_connection_id,status,
		       connect_expires_at,coalesce(connect_url,''),created_at,updated_at,coalesce(remote_team_id,''),
		       coalesce(remote_team_name,''),coalesce(remote_user_id,''),coalesce(remote_principal_key,''),coalesce(identity_label,''),
		       revision,status_checked_at,coalesce(status_error_code,''),auto_reminders,status_check_requested_at,
		       coalesce(reauthorization_upstream_id,''),coalesce(reauthorization_connect_url,''),reauthorization_connect_expires_at,coalesce(reauthorization_error_code,'')
		FROM external_connections
		WHERE id=$1 AND account_id=$2`, connectionID, accountID).Scan(
		&connection.ID, &connection.AccountID, &connection.Provider, &connection.UpstreamConnectionID,
		&connection.Status, &connection.ConnectExpiresAt, &connection.ConnectURL, &connection.CreatedAt, &connection.UpdatedAt, &connection.RemoteTeamID, &connection.RemoteTeamName, &connection.RemoteUserID, &connection.RemotePrincipalKey,
		&connection.IdentityLabel, &connection.Revision, &connection.StatusCheckedAt, &connection.StatusErrorCode, &connection.AutoReminders, &connection.StatusCheckRequestedAt,
		&connection.ReauthorizationUpstreamID, &connection.ReauthorizationConnectURL, &connection.ReauthorizationConnectExpiresAt, &connection.ReauthorizationErrorCode,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connection{}, ErrNotFound
	}
	return connection, err
}

func (s *Service) loadProviderConnection(ctx context.Context, accountID, connectionID, provider string) (Connection, error) {
	connection, err := s.loadConnection(ctx, accountID, connectionID)
	if err != nil {
		return Connection{}, err
	}
	if connection.Provider != provider {
		return Connection{}, ErrNotFound
	}
	return connection, nil
}

func (s *Service) loadAuthorizedConnection(ctx context.Context, accountID, tenantID, connectionID string) (Connection, error) {
	var connection Connection
	err := s.pool.QueryRow(ctx, `
		SELECT connection.id,connection.account_id,connection.provider,connection.upstream_connection_id,
		       connection.status,connection.connect_expires_at,connection.created_at,connection.updated_at,coalesce(connection.remote_team_id,''),coalesce(connection.remote_team_name,''),coalesce(connection.remote_user_id,''),
		       coalesce(connection.identity_label,''),connection.revision,connection.status_checked_at,coalesce(connection.status_error_code,'')
		FROM external_connections connection
		JOIN actors owner ON owner.account_id=connection.account_id
		  AND owner.tenant_id=$3 AND owner.kind='human'
		WHERE connection.id=$1 AND connection.account_id=$2`,
		connectionID, accountID, tenantID).Scan(
		&connection.ID, &connection.AccountID, &connection.Provider, &connection.UpstreamConnectionID,
		&connection.Status, &connection.ConnectExpiresAt, &connection.CreatedAt, &connection.UpdatedAt, &connection.RemoteTeamID, &connection.RemoteTeamName, &connection.RemoteUserID,
		&connection.IdentityLabel, &connection.Revision, &connection.StatusCheckedAt, &connection.StatusErrorCode,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connection{}, ErrNotFound
	}
	return connection, err
}

// ownerActorID returns the caller's Human Actor in the Tenant, which owns the
// Web Sources and import jobs recorded here.
func (s *Service) ownerActorID(ctx context.Context, accountID, tenantID string) (string, error) {
	actor, err := store.New(s.pool).GetHumanActor(ctx, store.GetHumanActorParams{
		TenantID: tenantID, AccountID: pgtype.Text{String: accountID, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return actor.ID, err
}

func mapDatabaseError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	if pgErr.Code == "23503" {
		return ErrNotFound
	}
	if pgErr.Code == "23505" {
		return ErrConflict
	}
	return err
}

// classifyConnectionAuthError distinguishes an invalid project key from a forbidden operation.
func classifyConnectionAuthError(err error) error {
	if status, ok := composio.ErrorStatus(err); ok && status == http.StatusForbidden {
		return errors.Join(ErrManagedKeyForbidden, err)
	}
	if composio.IsUnauthorized(err) {
		return errors.Join(ErrManagedKeyRejected, err)
	}
	return err
}
