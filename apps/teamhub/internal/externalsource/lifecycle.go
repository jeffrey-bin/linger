package externalsource

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

// ErrStaleRevision reports a Connection revision that changed since the caller read it.
var ErrStaleRevision = errors.New("external source revision is stale")

const disconnectTransactionMaxAttempts = 3

func (s *Service) ListConnections(ctx context.Context, accountID string) ([]Connection, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM external_connections WHERE account_id=$1 AND status<>'revoked' ORDER BY created_at DESC,id`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	connections := make([]Connection, 0, len(ids))
	for _, id := range ids {
		connection, err := s.loadConnection(ctx, accountID, id)
		if err != nil {
			return nil, err
		}
		connections = append(connections, connection)
	}
	return connections, rows.Err()
}

// Disconnect stops the Connection's access at once and revokes its upstream
// account in the background. The Connection is disconnecting until the revoke
// succeeds, then revoked.
func (s *Service) Disconnect(ctx context.Context, accountID, connectionID string, expectedRevision int64) (Connection, error) {
	if expectedRevision < 1 {
		return Connection{}, ErrInvalid
	}
	return retryDisconnectTransaction(func() (Connection, error) {
		return s.disconnectOnce(ctx, accountID, connectionID, expectedRevision)
	})
}

func retryDisconnectTransaction(operation func() (Connection, error)) (Connection, error) {
	var connection Connection
	var err error
	for attempt := 0; attempt < disconnectTransactionMaxAttempts; attempt++ {
		connection, err = operation()
		if err == nil || !isPostgresDeadlock(err) {
			return connection, err
		}
	}
	return Connection{}, err
}

func isPostgresDeadlock(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "40P01"
}

func (s *Service) disconnectOnce(ctx context.Context, accountID, connectionID string, expectedRevision int64) (Connection, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connection{}, err
	}
	defer tx.Rollback(ctx)
	var upstreamID, candidate string
	var revision int64
	err = tx.QueryRow(ctx, `SELECT upstream_connection_id,revision,coalesce(reauthorization_upstream_id,'') FROM external_connections WHERE id=$1 AND account_id=$2 FOR UPDATE`, connectionID, accountID).Scan(&upstreamID, &revision, &candidate)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connection{}, ErrNotFound
	}
	if err != nil {
		return Connection{}, err
	}
	if revision != expectedRevision {
		return Connection{}, ErrStaleRevision
	}
	if err = stopConnectionAccessTx(ctx, tx, connectionID); err != nil {
		return Connection{}, err
	}
	// A reauthorization in progress ends with the Connection.
	if candidate != "" {
		if _, err = s.endReauthorizationTx(ctx, tx, connectionID, candidate, "", false); err != nil {
			return Connection{}, err
		}
	}
	// The sweep queues the revoke again if its job is lost before it succeeds.
	if _, err = tx.Exec(ctx, `UPDATE external_connections SET status='disconnecting',revision=$3,connect_url=NULL,status_error_code=NULL,status_check_requested_at=NULL,next_status_check_at=now()+$4::interval,updated_at=now() WHERE id=$1 AND account_id=$2`, connectionID, accountID, revision+1, durationInterval(cleanupRetryDelay)); err != nil {
		return Connection{}, err
	}
	if err = enqueueRevokeTx(ctx, tx, connectionID, upstreamID); err != nil {
		return Connection{}, err
	}
	if err = s.commitAccountExternalConnectionsChange(ctx, tx, accountID); err != nil {
		return Connection{}, err
	}
	return s.loadConnection(ctx, accountID, connectionID)
}

// stopConnectionAccessTx ends the Connection's mailbox snapshot, drops its
// mail evidence, and revokes its Agent grants. A running import stops at its
// next fence, since the caller also changes the revision.
func stopConnectionAccessTx(ctx context.Context, tx pgx.Tx, connectionID string) error {
	if _, err := tx.Exec(ctx, `UPDATE external_connections SET mail_import_status=NULL,mail_import_revision=NULL,mail_import_tenant_id=NULL,mail_import_error_code=NULL,mail_import_cursor=NULL,mail_import_read=NULL,mail_import_provider_calls=NULL,mail_synced_until=NULL WHERE id=$1`, connectionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM external_mail_import_documents WHERE connection_id=$1`, connectionID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE external_connection_agent_grants SET status='revoked',revision=revision+1,revoked_at=now(),updated_at=now() WHERE connection_id=$1 AND status='active'`, connectionID)
	return err
}

// abandonConnectionAttempt ends a Connection that never became active once its
// Connect Link has expired. Like Disconnect it stops access and revokes the
// upstream account, which Composio may already have discarded; a rejected
// duplicate's upstream may already be revoked, and revoking it again finishes
// at once.
func (s *Service) abandonConnectionAttempt(ctx context.Context, connection Connection) error {
	return s.commitAccountExternalConnectionsMutation(ctx, connection.AccountID, func(tx pgx.Tx) (bool, error) {
		result, err := tx.Exec(ctx, `UPDATE external_connections SET status='disconnecting',revision=$3,connect_url=NULL,status_checked_at=now(),status_check_requested_at=NULL,next_status_check_at=now()+$4::interval,updated_at=now() WHERE id=$1 AND revision=$2 AND active_since IS NULL AND status NOT IN ('disconnecting','revoke_pending','revoked') AND reauthorization_upstream_id IS NULL`, connection.ID, connection.Revision, connection.Revision+1, durationInterval(cleanupRetryDelay))
		if err != nil || result.RowsAffected() != 1 {
			return false, err
		}
		if err = stopConnectionAccessTx(ctx, tx, connection.ID); err != nil {
			return false, err
		}
		return true, enqueueRevokeTx(ctx, tx, connection.ID, connection.UpstreamConnectionID)
	})
}

// reconcileConnectionJob works one Connection reconcile attempt. A Connection that
// is no longer due, or no longer in a reconcilable status, makes the attempt a no-op.
// A Connection that was never active is abandoned once its Connect Link has
// expired, unless Composio reports the account active after all or the user is
// reauthorizing it.
func (s *Service) reconcileConnectionJob(ctx context.Context, connectionID string, attempt int) (resultErr error) {
	var connection Connection
	var firstAttempt bool
	err := s.pool.QueryRow(ctx, `SELECT id,account_id,provider,upstream_connection_id,status,revision,coalesce(identity_label,''),coalesce(remote_principal_key,''),coalesce(remote_team_id,''),coalesce(remote_team_name,''),coalesce(remote_user_id,''),coalesce(status_error_code,''),connect_expires_at,status_check_requested_at,created_at,active_since IS NULL AND reauthorization_upstream_id IS NULL FROM external_connections WHERE id=$1 AND status IN ('pending','active','expired','failed') AND next_status_check_at<=now()`, connectionID).Scan(&connection.ID, &connection.AccountID, &connection.Provider, &connection.UpstreamConnectionID, &connection.Status, &connection.Revision, &connection.IdentityLabel, &connection.RemotePrincipalKey, &connection.RemoteTeamID, &connection.RemoteTeamName, &connection.RemoteUserID, &connection.StatusErrorCode, &connection.ConnectExpiresAt, &connection.StatusCheckRequestedAt, &connection.CreatedAt, &firstAttempt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	firstAttempt = firstAttempt && connection.ConnectExpiresAt != nil
	linkExpired := firstAttempt && !time.Now().Before(*connection.ConnectExpiresAt)
	ctx, check, err := s.beginConnectionCheck(ctx, connection, attempt)
	if err != nil {
		return err
	}
	check.hourlyRetryFloor = true
	defer check.finish(&resultErr)
	// A preceding replica may have completed after our due-row snapshot.
	var stillDue bool
	if err = check.session.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_connections WHERE id=$1 AND revision=$2 AND upstream_connection_id=$3 AND status=$4 AND next_status_check_at<=now())`, connection.ID, connection.Revision, connection.UpstreamConnectionID, connection.Status).Scan(&stillDue); err != nil {
		return err
	}
	if !stillDue {
		return nil
	}
	// A rejected duplicate's upstream is already being revoked.
	if linkExpired && connection.StatusErrorCode == "duplicate_remote_principal" {
		return s.abandonConnectionAttempt(ctx, connection)
	}

	status, err := s.connectionStatus(ctx, connection)
	if linkExpired && (err == nil && status != composio.ConnectionActive || err != nil && upstreamGone(err)) {
		return s.abandonConnectionAttempt(ctx, connection)
	}
	if err != nil {
		delay := check.failed("connection_status", err)
		code, _, _ := connectionIdentityFailurePolicy(connection.Provider, err)
		if code != "provider_rate_limited" {
			code = "provider_status_unavailable"
		}
		if mutationErr := s.commitAccountExternalConnectionsMutation(ctx, connection.AccountID, func(tx pgx.Tx) (bool, error) {
			result, updateErr := tx.Exec(ctx, `UPDATE external_connections SET status_error_code=$3,next_status_check_at=now()+$4::interval,status_check_requested_at=NULL,updated_at=now() WHERE id=$1 AND revision=$2`, connection.ID, connection.Revision, code, durationInterval(delay))
			return updateErr == nil && result.RowsAffected() == 1 && (connection.StatusErrorCode != code || connection.StatusCheckRequestedAt != nil), updateErr
		}); mutationErr != nil {
			return mutationErr
		}
		// The error makes River retry the reconcile, honoring a rate limit's Retry-After.
		return err
	}
	identityLabel, principal, teamID, teamName, userID, identifyErr := s.identifyExistingConnection(ctx, connection, status)
	if identifyErr != nil {
		errorCode, _, failConnection := connectionIdentityFailurePolicy(connection.Provider, identifyErr)
		retryAfter := check.failed("identity_refresh", identifyErr)
		updateErr := s.commitAccountExternalConnectionsMutation(ctx, connection.AccountID, func(tx pgx.Tx) (bool, error) {
			query := `UPDATE external_connections SET status_checked_at=now(),status_error_code=$3,status_check_requested_at=NULL,next_status_check_at=now()+$4::interval,updated_at=now() WHERE id=$1 AND revision=$2 AND status NOT IN ('disconnecting','revoke_pending','revoked')`
			if failConnection {
				query = `UPDATE external_connections SET status='failed',connect_url=NULL,status_checked_at=now(),status_error_code=$3,status_check_requested_at=NULL,next_status_check_at=now()+$4::interval,updated_at=now() WHERE id=$1 AND revision=$2 AND status NOT IN ('disconnecting','revoke_pending','revoked')`
			}
			result, err := tx.Exec(ctx, query, connection.ID, connection.Revision, errorCode, durationInterval(retryAfter))
			if err != nil {
				return false, err
			}
			return result.RowsAffected() == 1 && (connection.StatusErrorCode != errorCode || connection.StatusCheckRequestedAt != nil || (failConnection && connection.Status != "failed")), nil
		})
		if updateErr != nil {
			return updateErr
		}
		return identifyErr
	}
	if outcome, duplicateErr := s.reconcileDuplicateConnection(ctx, connection, status, connectionIdentity{Label: identityLabel, PrincipalKey: principal, RemoteTeamID: teamID, RemoteTeamName: teamName, UserID: userID}); duplicateErr != nil || outcome != duplicateConnectionNone {
		return duplicateErr
	}
	now := time.Now().UTC()
	pendingPoll := pendingConnectionPoll(connection.CreatedAt, now)
	nextCheck := now.Add(6 * time.Hour)
	switch {
	case status == composio.ConnectionPending:
		nextCheck = now.Add(pendingPoll)
	case firstAttempt && status != composio.ConnectionActive:
		// A failed first attempt is abandoned as soon as its Connect Link expires.
		nextCheck = *connection.ConnectExpiresAt
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `UPDATE external_connections SET status=$2,active_since=CASE WHEN $2='active' THEN coalesce(active_since,now()) ELSE active_since END,identity_label=coalesce(nullif($3,''),identity_label),remote_principal_key=coalesce(nullif(remote_principal_key,''),nullif($4,'')),remote_team_id=coalesce(nullif($5,''),remote_team_id),remote_team_name=coalesce(nullif($6,''),remote_team_name),remote_user_id=coalesce(nullif($7,''),remote_user_id),status_checked_at=now(),next_status_check_at=$8,connect_url=CASE WHEN $2='pending' THEN connect_url END,status_error_code=NULL,status_check_requested_at=NULL,updated_at=now() WHERE id=$1 AND revision=$9 AND status NOT IN ('disconnecting','revoke_pending','revoked')`, connection.ID, string(status), identityLabel, principal, teamID, teamName, userID, nextCheck, connection.Revision)
	if err != nil || result.RowsAffected() == 0 {
		return err
	}
	if status == composio.ConnectionActive {
		if err = s.connectionActivatedTx(ctx, tx, connection.AccountID, connection.ID, connection.Status); err != nil {
			return err
		}
	}
	changed := connection.Status != string(status) || connection.StatusErrorCode != "" || connection.StatusCheckRequestedAt != nil ||
		(identityLabel != "" && connection.IdentityLabel != identityLabel) ||
		(connection.RemotePrincipalKey == "" && principal != "") ||
		(teamID != "" && connection.RemoteTeamID != teamID) ||
		(teamName != "" && connection.RemoteTeamName != teamName) ||
		(userID != "" && connection.RemoteUserID != userID)
	if !changed {
		if err = tx.Commit(ctx); err != nil {
			return err
		}
	} else if err = s.commitAccountExternalConnectionsChange(ctx, tx, connection.AccountID); err != nil {
		return err
	}
	if status == composio.ConnectionPending {
		return &connectionPending{poll: pendingPoll}
	}
	return nil
}

func connectionIdentityFailurePolicy(provider string, err error) (code string, retryAfter time.Duration, failConnection bool) {
	var limited *composio.RateLimitError
	if errors.As(err, &limited) {
		return "provider_rate_limited", max(time.Minute, limited.RetryAfter), false
	}
	if provider == "discord" && errors.Is(err, composio.ErrDiscordGuildRequired) {
		return "discord_guild_required", 6 * time.Hour, false
	}
	if composio.IsAuthFailure(err) || errors.Is(err, composio.ErrDiscordGuildNotAccessible) {
		return "provider_auth_failed", 6 * time.Hour, true
	}
	var slackAccess *composio.SlackAccessError
	if errors.As(err, &slackAccess) {
		return "provider_auth_failed", 6 * time.Hour, true
	}
	return "provider_identity_unavailable", time.Minute, false
}

func (s *Service) duplicatePrincipalConnection(ctx context.Context, accountID, provider, principal, excludeConnectionID string) (string, error) {
	if principal == "" {
		return "", nil
	}
	var duplicateID string
	err := s.pool.QueryRow(ctx, `SELECT id FROM external_connections WHERE account_id=$1 AND provider=$2 AND remote_principal_key=$3 AND id<>$4 AND status<>'revoked' ORDER BY created_at,id LIMIT 1`, accountID, provider, principal, excludeConnectionID).Scan(&duplicateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return duplicateID, err
}

type duplicateConnectionOutcome uint8

const (
	duplicateConnectionNone duplicateConnectionOutcome = iota
	duplicateConnectionRejected
	duplicateConnectionRecovered
)

func (s *Service) reconcileDuplicateConnection(ctx context.Context, connection Connection, remoteStatus composio.ConnectionStatus, identity connectionIdentity) (duplicateConnectionOutcome, error) {
	if remoteStatus != composio.ConnectionActive {
		return duplicateConnectionNone, nil
	}
	duplicateID, err := s.duplicatePrincipalConnection(ctx, connection.AccountID, connection.Provider, identity.PrincipalKey, connection.ID)
	if err != nil || duplicateID == "" {
		return duplicateConnectionNone, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return duplicateConnectionNone, err
	}
	defer tx.Rollback(ctx)
	type lockedConnection struct {
		id, accountID, provider, upstream, status, principal string
		revision                                             int64
	}
	rows, err := tx.Query(ctx, `SELECT id,account_id,provider,upstream_connection_id,status,revision,coalesce(remote_principal_key,'') FROM external_connections WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE`, connection.ID, duplicateID)
	if err != nil {
		return duplicateConnectionNone, err
	}
	locked := map[string]lockedConnection{}
	for rows.Next() {
		var item lockedConnection
		if err = rows.Scan(&item.id, &item.accountID, &item.provider, &item.upstream, &item.status, &item.revision, &item.principal); err != nil {
			rows.Close()
			return duplicateConnectionNone, err
		}
		locked[item.id] = item
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return duplicateConnectionNone, err
	}
	candidate, candidateExists := locked[connection.ID]
	duplicate, duplicateExists := locked[duplicateID]
	if !candidateExists || candidate.accountID != connection.AccountID || candidate.provider != connection.Provider || candidate.upstream != connection.UpstreamConnectionID || candidate.revision != connection.Revision || candidate.status == "disconnecting" || candidate.status == "revoke_pending" || candidate.status == "revoked" {
		return duplicateConnectionNone, ErrStaleRevision
	}
	if !duplicateExists || duplicate.accountID != connection.AccountID || duplicate.provider != connection.Provider || duplicate.principal != identity.PrincipalKey || duplicate.status == "revoked" {
		return duplicateConnectionNone, nil
	}
	// An upstream TeamHub already gave up is never adopted again.
	var givenUp bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM external_connection_upstreams WHERE upstream_id=$1 AND revoke_requested_at IS NOT NULL)`, candidate.upstream).Scan(&givenUp); err != nil {
		return duplicateConnectionNone, err
	}
	if !givenUp && (duplicate.status == "expired" || duplicate.status == "failed") {
		// The newly authorized upstream is the recovery credential for the existing
		// principal. Preserve the canonical Connection ID and all of its dependencies.
		temporaryUpstream := idgen.New("superseded_upstream")
		candidateUpdate, updateErr := tx.Exec(ctx, `UPDATE external_connections SET upstream_connection_id=$3,status='revoked',connect_url=NULL,identity_label=coalesce(nullif($4,''),identity_label),status_checked_at=now(),status_error_code='duplicate_remote_principal',status_check_requested_at=NULL,updated_at=now() WHERE id=$1 AND revision=$2 AND status NOT IN ('disconnecting','revoke_pending','revoked')`, connection.ID, connection.Revision, temporaryUpstream, identity.Label)
		if updateErr != nil {
			return duplicateConnectionNone, updateErr
		}
		if candidateUpdate.RowsAffected() != 1 {
			return duplicateConnectionNone, ErrStaleRevision
		}
		newRevision := duplicate.revision + 1
		canonicalUpdate, updateErr := tx.Exec(ctx, `UPDATE external_connections SET upstream_connection_id=$3,auth_config_id=coalesce((SELECT auth_config_id FROM external_connection_upstreams WHERE upstream_id=$3),auth_config_id),status='active',active_since=now(),revision=$4,remote_principal_key=$5,identity_label=$6,remote_team_id=nullif($7,''),remote_team_name=nullif($8,''),remote_user_id=nullif($9,''),status_checked_at=now(),next_status_check_at=now()+interval '6 hours',status_error_code=NULL,status_check_requested_at=NULL,updated_at=now() WHERE id=$1 AND revision=$2 AND status IN ('expired','failed')`, duplicateID, duplicate.revision, connection.UpstreamConnectionID, newRevision, identity.PrincipalKey, identity.Label, identity.RemoteTeamID, identity.RemoteTeamName, identity.UserID)
		if updateErr != nil {
			return duplicateConnectionNone, updateErr
		}
		if canonicalUpdate.RowsAffected() != 1 {
			return duplicateConnectionNone, ErrStaleRevision
		}
		if err = s.connectionActivatedTx(ctx, tx, connection.AccountID, duplicateID, duplicate.status); err != nil {
			return duplicateConnectionNone, err
		}
		candidateSwap, updateErr := tx.Exec(ctx, `UPDATE external_connections SET upstream_connection_id=$2 WHERE id=$1 AND upstream_connection_id=$3`, connection.ID, duplicate.upstream, temporaryUpstream)
		if updateErr != nil {
			return duplicateConnectionNone, updateErr
		}
		if candidateSwap.RowsAffected() != 1 {
			return duplicateConnectionNone, ErrStaleRevision
		}
		if err = s.cancelSupersededConnectionRecovery(ctx, tx, duplicateID, connection.UpstreamConnectionID); err != nil {
			return duplicateConnectionNone, err
		}
		if err = enqueueRevokeTx(ctx, tx, duplicateID, duplicate.upstream); err != nil {
			return duplicateConnectionNone, err
		}
		if err = s.commitAccountExternalConnectionsChange(ctx, tx, connection.AccountID); err != nil {
			return duplicateConnectionNone, err
		}
		return duplicateConnectionRecovered, nil
	}
	result, err := tx.Exec(ctx, `UPDATE external_connections SET status='failed',connect_url=NULL,identity_label=coalesce(nullif($3,''),identity_label),remote_team_id=nullif($4,''),remote_team_name=nullif($5,''),remote_user_id=nullif($6,''),status_checked_at=now(),next_status_check_at=CASE WHEN active_since IS NULL AND connect_expires_at IS NOT NULL THEN greatest(now(),connect_expires_at) ELSE now()+interval '6 hours' END,status_error_code='duplicate_remote_principal',status_check_requested_at=NULL,updated_at=now() WHERE id=$1 AND revision=$2 AND status NOT IN ('disconnecting','revoke_pending','revoked')`, connection.ID, connection.Revision, identity.Label, identity.RemoteTeamID, identity.RemoteTeamName, identity.UserID)
	if err != nil {
		return duplicateConnectionNone, err
	}
	if result.RowsAffected() != 1 {
		return duplicateConnectionNone, ErrStaleRevision
	}
	if err = enqueueRevokeTx(ctx, tx, connection.ID, connection.UpstreamConnectionID); err != nil {
		return duplicateConnectionNone, err
	}
	if err = s.commitAccountExternalConnectionsChange(ctx, tx, connection.AccountID); err != nil {
		return duplicateConnectionNone, err
	}
	return duplicateConnectionRejected, nil
}

// cancelSupersededConnectionRecovery ends a reauthorization of a Connection
// another upstream just recovered, revoking its candidate unless it is the
// recovered upstream.
func (s *Service) cancelSupersededConnectionRecovery(ctx context.Context, tx pgx.Tx, connectionID, recoveredUpstream string) error {
	var candidate string
	if err := tx.QueryRow(ctx, `SELECT coalesce(reauthorization_upstream_id,'') FROM external_connections WHERE id=$1`, connectionID).Scan(&candidate); err != nil || candidate == "" {
		return err
	}
	_, err := s.endReauthorizationTx(ctx, tx, connectionID, candidate, "stale_revision", candidate == recoveredUpstream)
	return err
}
