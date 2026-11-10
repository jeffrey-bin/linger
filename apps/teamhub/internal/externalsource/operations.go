package externalsource

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// CreateStatusCheck makes the Connection's reconcile due at once. The request
// stays visible as status_check_requested_at until the reconcile writes its
// result to the Connection; a request while one is pending keeps it.
func (s *Service) CreateStatusCheck(ctx context.Context, accountID, connectionID string, expectedRevision int64) (Connection, error) {
	if expectedRevision < 1 {
		return Connection{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connection{}, err
	}
	defer tx.Rollback(ctx)
	var revision int64
	var status string
	if err := tx.QueryRow(ctx, `SELECT revision,status FROM external_connections WHERE id=$1 AND account_id=$2 FOR UPDATE`, connectionID, accountID).Scan(&revision, &status); errors.Is(err, pgx.ErrNoRows) {
		return Connection{}, ErrNotFound
	} else if err != nil {
		return Connection{}, err
	}
	if revision != expectedRevision {
		return Connection{}, ErrStaleRevision
	}
	// Only a Connection the reconcile checks can be checked on request.
	if status != "pending" && status != "active" && status != "expired" && status != "failed" {
		return Connection{}, ErrConflict
	}
	var requestedAt time.Time
	if err = tx.QueryRow(ctx, `UPDATE external_connections SET next_status_check_at=now(),status_check_requested_at=coalesce(status_check_requested_at,now()),updated_at=now() WHERE id=$1 RETURNING clock_timestamp()`, connectionID).Scan(&requestedAt); err != nil {
		return Connection{}, err
	}
	if err = jobs.InsertTx(ctx, tx, ConnectionReconcileArgs{ConnectionID: connectionID, RequestedAt: &requestedAt}, nil); err != nil {
		return Connection{}, err
	}
	if err = s.commitAccountExternalConnectionsChange(ctx, tx, accountID); err != nil {
		return Connection{}, err
	}
	return s.loadConnection(ctx, accountID, connectionID)
}

func (s *Service) identifyConnection(ctx context.Context, provider, upstream string, status composio.ConnectionStatus) (label, principal, teamID, teamName, userID string, err error) {
	adapter, err := s.connectionAdapter(provider)
	if err != nil {
		return "", "", "", "", "", err
	}
	identity, err := adapter.Identify(ctx, upstream, status)
	if err != nil {
		return "", "", "", "", "", err
	}
	return identity.Label, identity.PrincipalKey, identity.RemoteTeamID, identity.RemoteTeamName, identity.UserID, nil
}

func (s *Service) identifyExistingConnection(ctx context.Context, connection Connection, status composio.ConnectionStatus) (label, principal, teamID, teamName, userID string, err error) {
	if connection.Provider == "gmail" && status == composio.ConnectionActive && connection.Status == "active" && strings.HasPrefix(connection.RemotePrincipalKey, "gmail:") && strings.TrimSpace(strings.TrimPrefix(connection.RemotePrincipalKey, "gmail:")) != "" && strings.TrimSpace(connection.IdentityLabel) != "" {
		return connection.IdentityLabel, connection.RemotePrincipalKey, "", "", "", nil
	}
	if connection.Provider != "discord" || status != composio.ConnectionActive || validateDiscordGuildID(connection.RemoteTeamID) != nil {
		return s.identifyConnection(ctx, connection.Provider, connection.UpstreamConnectionID, status)
	}
	if s.provider == nil {
		return "", "", "", "", "", ErrUnavailable
	}
	identity, err := s.provider.GetDiscordGuild(ctx, connection.UpstreamConnectionID, connection.RemoteTeamID)
	if err != nil {
		return "", "", "", "", "", err
	}
	if identity.GuildID != connection.RemoteTeamID || strings.TrimSpace(identity.GuildName) == "" {
		return "", "", "", "", "", ErrInvalid
	}
	name := strings.TrimSpace(identity.GuildName)
	return name, "discord:guild:" + identity.GuildID, identity.GuildID, name, "", nil
}

// CreateReauthorization opens a Connect Link for a new upstream account of an
// expired or failed Connection. The attempt lives on the Connection: its
// candidate upstream and link until the reauthorization job settles it.
func (s *Service) CreateReauthorization(ctx context.Context, accountID, connectionID string, expectedRevision int64) (Connection, error) {
	if expectedRevision < 1 {
		return Connection{}, ErrInvalid
	}
	connection, err := s.loadConnection(ctx, accountID, connectionID)
	if err != nil {
		return Connection{}, err
	}
	// Without Composio no app supports Agent tools, so this also rejects an
	// unconfigured deployment before it reaches the managed auth config.
	if s.appIdentity(connection.Provider) == nil || !s.SupportsAgentTools(connection.Provider) {
		return Connection{}, ErrUnavailable
	}
	managedConfigID, err := s.ensureAuthConfig(ctx, connection.Provider)
	if err != nil {
		return Connection{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connection{}, err
	}
	defer tx.Rollback(ctx)
	var provider, status, candidate string
	var revision int64
	var candidateExpired bool
	if err = tx.QueryRow(ctx, `SELECT provider,status,revision,coalesce(reauthorization_upstream_id,''),coalesce(reauthorization_connect_expires_at<=now(),false) FROM external_connections WHERE id=$1 AND account_id=$2 FOR UPDATE`, connectionID, accountID).Scan(&provider, &status, &revision, &candidate, &candidateExpired); errors.Is(err, pgx.ErrNoRows) {
		return Connection{}, ErrNotFound
	} else if err != nil {
		return Connection{}, err
	}
	if revision != expectedRevision {
		return Connection{}, ErrStaleRevision
	}
	if status != "expired" && status != "failed" {
		return Connection{}, ErrConflict
	}
	// A reauthorization whose Connect Link expired is replaced; one still in
	// progress is reused, and its job is queued again in case it was lost.
	if candidateExpired {
		if _, err = s.endReauthorizationTx(ctx, tx, connectionID, candidate, "connect_link_expired", false); err != nil {
			return Connection{}, err
		}
		candidate = ""
	}
	if candidate != "" {
		if err = jobs.InsertOrWakeTx(ctx, tx, ReauthorizationArgs{ConnectionID: connectionID}, nil); err != nil {
			return Connection{}, err
		}
	} else {
		link, err := s.createManagedLinkInTx(ctx, tx, accountID, toolkitForApp(provider), managedConfigID)
		if err != nil {
			return Connection{}, errors.Join(ErrUnavailable, err)
		}
		if _, err = tx.Exec(ctx, `UPDATE external_connections SET reauthorization_upstream_id=$2,reauthorization_connect_url=$3,reauthorization_connect_expires_at=$4,reauthorization_error_code=NULL,updated_at=now() WHERE id=$1`, connectionID, link.ConnectedAccountID, link.RedirectURL, link.ExpiresAt); err != nil {
			return Connection{}, mapDatabaseError(err)
		}
		// The user is only now opening the Connect Link; a returning popup checks sooner.
		if err = jobs.InsertTx(ctx, tx, ReauthorizationArgs{ConnectionID: connectionID}, &river.InsertOpts{ScheduledAt: time.Now().Add(connectingPoll)}); err != nil {
			return Connection{}, err
		}
	}
	if err = s.commitAccountExternalConnectionsChange(ctx, tx, accountID); err != nil {
		return Connection{}, err
	}
	return s.loadConnection(ctx, accountID, connectionID)
}

// ReauthorizationArgs names the Connection whose reauthorization is in
// progress. The Connection row stays the durable state; the River job only
// schedules its polls.
type ReauthorizationArgs struct {
	ConnectionID string `json:"connection_id"`
}

const (
	reauthorizationKind = "external.reauthorization"
	// reauthorizationMaxAttempts bounds errors while a Connection is being reauthorized.
	reauthorizationMaxAttempts = 25
)

// errReauthorizationPending reports that the candidate is still connecting. The
// worker polls again instead of settling the reauthorization.
var errReauthorizationPending = errors.New("reauthorization candidate pending")

func (ReauthorizationArgs) Kind() string { return reauthorizationKind }

func (ReauthorizationArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueExternal, MaxAttempts: reauthorizationMaxAttempts, UniqueOpts: jobs.UniqueUnfinished}
}

type reauthorizationWorker struct {
	river.WorkerDefaults[ReauthorizationArgs]
	service *Service
}

func (*reauthorizationWorker) Timeout(*river.Job[ReauthorizationArgs]) time.Duration {
	return connectionJobTimeout
}

// NextRetry spaces error retries with the connection check backoff for this
// reauthorization. It does not use the reconcile's hourly floor, so a connect
// link can still complete before it expires.
func (w *reauthorizationWorker) NextRetry(job *river.Job[ReauthorizationArgs]) time.Time {
	return time.Now().Add(connectionCheckRetryDelay("reauthorization:"+job.Args.ConnectionID, job.Attempt, 0))
}

func (w *reauthorizationWorker) Work(ctx context.Context, job *river.Job[ReauthorizationArgs]) error {
	err := w.service.reconcileOneReauthorization(ctx, job.Args.ConnectionID, job.Attempt)
	var deferred *connectionCheckDeferred
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errReauthorizationPending):
		// The job is created when the user starts reauthorizing.
		return river.JobSnooze(pendingConnectionPoll(job.CreatedAt, time.Now()))
	case errors.As(err, &deferred):
		return river.JobSnooze(time.Until(deferred.until))
	case job.Attempt < reauthorizationMaxAttempts:
		return err
	default:
		// The candidate stays unrevoked: whether it can be revoked is what kept failing.
		_, failErr := w.service.pool.Exec(ctx, `UPDATE external_connections SET reauthorization_upstream_id=NULL,reauthorization_connect_url=NULL,reauthorization_connect_expires_at=NULL,reauthorization_error_code='internal_error',updated_at=now() WHERE id=$1 AND reauthorization_upstream_id IS NOT NULL`, job.Args.ConnectionID)
		return errors.Join(err, failErr)
	}
}

// reauthorizationOutcome settles a reauthorization from its candidate's
// upstream status and identity: state is "pending", "active" or "failed",
// with the error code a failure records on the Connection.
func reauthorizationOutcome(status composio.ConnectionStatus, statusErr error, linkExpired, compatible, duplicate bool) (state, code string) {
	switch {
	case statusErr == nil && status == composio.ConnectionPending && !linkExpired:
		return "pending", ""
	case statusErr != nil || status != composio.ConnectionActive:
		if linkExpired {
			return "failed", "connect_link_expired"
		}
		return "failed", "candidate_not_active"
	case duplicate:
		return "failed", "duplicate_remote_principal"
	case !compatible:
		return "failed", "identity_mismatch"
	default:
		return "active", ""
	}
}

// endReauthorizationTx clears the Connection's reauthorization of candidate,
// recording code, and revokes the candidate unless keepCandidate.
func (s *Service) endReauthorizationTx(ctx context.Context, tx pgx.Tx, connectionID, candidate, code string, keepCandidate bool) (bool, error) {
	result, err := tx.Exec(ctx, `UPDATE external_connections SET reauthorization_upstream_id=NULL,reauthorization_connect_url=NULL,reauthorization_connect_expires_at=NULL,reauthorization_error_code=nullif($3,''),updated_at=now() WHERE id=$1 AND reauthorization_upstream_id=$2`, connectionID, candidate, code)
	if err != nil || result.RowsAffected() != 1 {
		return false, err
	}
	if keepCandidate {
		return true, nil
	}
	return true, enqueueRevokeTx(ctx, tx, connectionID, candidate)
}

// reconcileOneReauthorization works one reauthorization attempt. A Connection
// with no reauthorization in progress makes the attempt a no-op.
func (s *Service) reconcileOneReauthorization(ctx context.Context, connectionID string, attempt int) (resultErr error) {
	var accountID, candidateUpstream, provider, originalPrincipal, oldUpstream, remoteTeamID, connectionStatus string
	var connectExpiresAt time.Time
	var revision int64
	err := s.pool.QueryRow(ctx, `SELECT account_id,reauthorization_upstream_id,reauthorization_connect_expires_at,provider,coalesce(remote_principal_key,''),upstream_connection_id,revision,coalesce(remote_team_id,''),status FROM external_connections WHERE id=$1 AND reauthorization_upstream_id IS NOT NULL`, connectionID).Scan(&accountID, &candidateUpstream, &connectExpiresAt, &provider, &originalPrincipal, &oldUpstream, &revision, &remoteTeamID, &connectionStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	linkExpired := !time.Now().UTC().Before(connectExpiresAt)
	candidate := Connection{ID: connectionID, AccountID: accountID, Provider: provider, UpstreamConnectionID: candidateUpstream}
	ctx, check, err := s.beginConnectionCheck(ctx, candidate, attempt)
	if err != nil {
		return err
	}
	defer check.finish(&resultErr)
	// An expired link is checked once more: the user may have finished just in time.
	status, err := s.connectionStatus(ctx, candidate)
	if err != nil && !(linkExpired && upstreamGone(err)) {
		check.failed("connection_status", err)
		return err
	}
	state, code := reauthorizationOutcome(status, err, linkExpired, true, false)
	if state == "pending" {
		return errReauthorizationPending
	}
	if state == "failed" {
		// Only the candidate's upstream is revoked; the Connection keeps its own.
		return s.commitAccountExternalConnectionsMutation(ctx, accountID, func(tx pgx.Tx) (bool, error) {
			return s.endReauthorizationTx(ctx, tx, connectionID, candidateUpstream, code, false)
		})
	}
	label, principal, teamID, teamName, userID, err := s.identifyExistingConnection(ctx, Connection{
		Provider: provider, UpstreamConnectionID: candidateUpstream, RemoteTeamID: remoteTeamID,
	}, status)
	if err != nil {
		check.failed("identity_refresh", err)
		return err
	}
	duplicateID, duplicateErr := s.duplicatePrincipalConnection(ctx, accountID, provider, principal, connectionID)
	if duplicateErr != nil {
		return duplicateErr
	}
	state, code = reauthorizationOutcome(status, nil, linkExpired, originalPrincipal == "" || originalPrincipal == principal, duplicateID != "")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if state == "failed" {
		ended, err := s.endReauthorizationTx(ctx, tx, connectionID, candidateUpstream, code, false)
		if err != nil {
			return err
		}
		if !ended {
			return ErrStaleRevision
		}
		return s.commitAccountExternalConnectionsChange(ctx, tx, accountID)
	}
	newRevision := revision + 1
	result, err := tx.Exec(ctx, `UPDATE external_connections SET upstream_connection_id=$3,auth_config_id=coalesce((SELECT auth_config_id FROM external_connection_upstreams WHERE upstream_id=$3),auth_config_id),status='active',active_since=now(),revision=$4,remote_principal_key=$5,identity_label=$6,remote_team_id=nullif($7,''),remote_team_name=nullif($8,''),remote_user_id=nullif($9,''),status_checked_at=now(),next_status_check_at=now()+interval '6 hours',status_error_code=NULL,status_check_requested_at=NULL,reauthorization_upstream_id=NULL,reauthorization_connect_url=NULL,reauthorization_connect_expires_at=NULL,reauthorization_error_code=NULL,updated_at=now() WHERE id=$1 AND revision=$2 AND reauthorization_upstream_id=$3 AND status IN ('expired','failed')`, connectionID, revision, candidateUpstream, newRevision, principal, label, teamID, teamName, userID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrStaleRevision
	}
	if err = s.connectionActivatedTx(ctx, tx, accountID, connectionID, connectionStatus); err != nil {
		return err
	}
	if err = enqueueRevokeTx(ctx, tx, connectionID, oldUpstream); err != nil {
		return err
	}
	return s.commitAccountExternalConnectionsChange(ctx, tx, accountID)
}
