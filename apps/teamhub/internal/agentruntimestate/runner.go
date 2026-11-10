package agentruntimestate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	computerIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	daemonIDPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

// GetLocalComputer reads a Computer that was not removed.
func (s *Service) GetLocalComputer(ctx context.Context, computerID string) (LocalComputer, error) {
	if s == nil || s.pool == nil || !validComputerID(computerID) {
		return LocalComputer{}, ErrInvalid
	}
	row, err := store.New(s.pool).GetAgentRuntimeLocalComputer(ctx, computerID)
	if isNoRows(err) || (err == nil && row.Status == "removed") {
		return LocalComputer{}, ErrNotFound
	}
	if err != nil {
		return LocalComputer{}, err
	}
	return localComputerFromRow(row)
}

// ConnectLocalComputer records a Computer's hello and returns the Agents
// placed on it. The credential must be the Computer's current one, and a
// Computer keeps the Daemon Identity it first connected with. The placements
// are read in the same transaction as the observation, so a move committed
// before it is already absent and one committed after it reaches the Computer
// at its next Run or reconnect.
func (s *Service) ConnectLocalComputer(ctx context.Context, input ConnectLocalComputerInput) (ConnectLocalComputerResult, error) {
	if !validComputerID(input.ComputerID) || !validOwner(input.Owner) || input.CredentialGeneration < 0 ||
		!daemonIDPattern.MatchString(input.DaemonID) || len(input.DaemonPublicKey) != 32 || input.IdentityVersion < 1 ||
		!slices.Contains([]string{"online", "offline"}, input.Status) || input.SeenAt.IsZero() ||
		!validDisplayName(input.DisplayName) || (input.Capacity != nil && *input.Capacity < 0) ||
		!slices.Contains([]string{"", "darwin", "linux", "win32"}, input.Platform) ||
		!validText(input.DaemonVersion, 1, 64) || len(input.RecommendedVersion) > 64 {
		return ConnectLocalComputerResult{}, ErrInvalid
	}
	runtimes, err := canonicalJSONArray(input.Runtimes)
	if err != nil {
		return ConnectLocalComputerResult{}, err
	}
	diagnostics, err := canonicalJSONArray(input.RuntimeDiagnostics)
	if err != nil {
		return ConnectLocalComputerResult{}, err
	}
	grants, err := canonicalJSONArray(input.WorkspaceGrants)
	if err != nil {
		return ConnectLocalComputerResult{}, err
	}
	return executeLocalComputerTx(ctx, s, func(ctx context.Context, tx pgx.Tx, queries *store.Queries) (ConnectLocalComputerResult, *LocalComputerOwner, error) {
		current, err := queries.LockAgentRuntimeLocalComputer(ctx, input.ComputerID)
		if isNoRows(err) || (err == nil && (current.Status == "removed" || current.OwnerTenantID != input.Owner.TenantID ||
			current.OwnerActorID != input.Owner.OwnerActorID)) {
			return ConnectLocalComputerResult{}, nil, ErrNotFound
		}
		if err != nil {
			return ConnectLocalComputerResult{}, nil, err
		}
		if current.CredentialGeneration != input.CredentialGeneration {
			return ConnectLocalComputerResult{}, nil, ErrConflict
		}
		if _, err := queries.BindAgentRuntimeLocalComputerDaemonIdentity(ctx, store.BindAgentRuntimeLocalComputerDaemonIdentityParams{
			DaemonID: input.DaemonID, DaemonPublicKey: input.DaemonPublicKey,
			IdentityVersion: input.IdentityVersion, ComputerID: input.ComputerID,
		}); isNoRows(err) {
			return ConnectLocalComputerResult{}, nil, ErrConflict
		} else if isDaemonIdentityInUse(err) {
			return ConnectLocalComputerResult{}, nil, ErrDaemonIdentityInUse
		} else if err != nil {
			return ConnectLocalComputerResult{}, nil, err
		}
		row, err := queries.ObserveAgentRuntimeLocalComputer(ctx, store.ObserveAgentRuntimeLocalComputerParams{
			DisplayName: strings.TrimSpace(input.DisplayName), Status: input.Status,
			Platform: optionalText(input.Platform), Capacity: optionalInt4(input.Capacity),
			RuntimeInventory: runtimes, RuntimeDiagnostics: diagnostics, WorkspaceGrants: grants,
			DaemonVersion: optionalText(input.DaemonVersion), RecommendedVersion: optionalText(input.RecommendedVersion),
			LastSeenAt: timestamptz(input.SeenAt), ComputerID: input.ComputerID,
		})
		if err != nil {
			return ConnectLocalComputerResult{}, nil, err
		}
		if err := s.runOnlineHooks(ctx, tx, row); err != nil {
			return ConnectLocalComputerResult{}, nil, err
		}
		computer, err := localComputerFromRow(row)
		if err != nil {
			return ConnectLocalComputerResult{}, nil, err
		}
		rows, err := queries.ListAgentRunnerPlacementsOnComputer(ctx, input.ComputerID)
		if err != nil {
			return ConnectLocalComputerResult{}, nil, err
		}
		placements := make([]RunnerPlacement, len(rows))
		for index, placement := range rows {
			placements[index] = RunnerPlacement{
				AgentID: placement.AgentManagementID, ActorID: placement.ActorID, TenantID: placement.TenantID,
				OwnerActorID: placement.CreatedByActorID, RuntimeType: placement.LocalRuntimeType,
				Model: placement.RuntimeModel, ReasoningEffort: placement.RuntimeReasoningEffort.String,
				WorkspaceGrantID: placement.WorkspaceGrantID, AssignmentRevision: placement.AssignmentRevision,
			}
		}
		result := ConnectLocalComputerResult{Computer: computer, Placements: placements}
		changed, err := localComputerChanged(current, row)
		if err != nil || !changed {
			return result, nil, err
		}
		return result, &computer.Owner, nil
	})
}

// TouchLocalComputer records a heartbeat, a disconnect, new Runtime
// diagnostics, or a Computer that only updates or reinstalls itself.
func (s *Service) TouchLocalComputer(ctx context.Context, input TouchLocalComputerInput) (LocalComputer, error) {
	if s == nil || s.pool == nil || !validComputerID(input.ComputerID) ||
		!slices.Contains([]string{"online", "offline", "upgrade_required"}, input.Status) || input.SeenAt.IsZero() ||
		len(input.DaemonVersion) > 64 || len(input.RecommendedVersion) > 64 {
		return LocalComputer{}, ErrInvalid
	}
	var runtimes, diagnostics []byte
	var err error
	if len(input.Runtimes) > 0 {
		if runtimes, err = canonicalJSONArray(input.Runtimes); err != nil {
			return LocalComputer{}, err
		}
	}
	if len(input.RuntimeDiagnostics) > 0 {
		if diagnostics, err = canonicalJSONArray(input.RuntimeDiagnostics); err != nil {
			return LocalComputer{}, err
		}
	}
	return executeLocalComputerTx(ctx, s, func(ctx context.Context, tx pgx.Tx, queries *store.Queries) (LocalComputer, *LocalComputerOwner, error) {
		current, err := queries.LockAgentRuntimeLocalComputer(ctx, input.ComputerID)
		if isNoRows(err) || (err == nil && current.Status == "removed") {
			return LocalComputer{}, nil, ErrNotFound
		}
		if err != nil {
			return LocalComputer{}, nil, err
		}
		if current.LastSeenAt.Valid && !input.SeenAt.After(current.LastSeenAt.Time) {
			computer, err := localComputerFromRow(current)
			return computer, nil, err
		}
		row, err := queries.TouchAgentRuntimeLocalComputer(ctx, store.TouchAgentRuntimeLocalComputerParams{
			Status: input.Status, RuntimeInventory: runtimes, RuntimeDiagnostics: diagnostics,
			DaemonVersion: optionalText(input.DaemonVersion), RecommendedVersion: optionalText(input.RecommendedVersion),
			ActiveOperations: optionalInt4(input.ActiveOperations), LastSeenAt: timestamptz(input.SeenAt),
			ComputerID: input.ComputerID,
		})
		if isNoRows(err) {
			return LocalComputer{}, nil, ErrNotFound
		}
		if err != nil {
			return LocalComputer{}, nil, err
		}
		if err := s.runOnlineHooks(ctx, tx, row); err != nil {
			return LocalComputer{}, nil, err
		}
		computer, err := localComputerFromRow(row)
		if err != nil {
			return LocalComputer{}, nil, err
		}
		changed, err := localComputerChanged(current, row)
		if err != nil || !changed {
			return computer, nil, err
		}
		return computer, &computer.Owner, nil
	})
}

// localComputerChanged reports whether the Web's view of a Computer changed:
// its connection state, Runtimes, workspaces, versions or load.
func localComputerChanged(previous, current store.LocalComputer) (bool, error) {
	for _, pair := range [][2][]byte{
		{previous.RuntimeInventory, current.RuntimeInventory},
		{previous.RuntimeDiagnostics, current.RuntimeDiagnostics},
		{previous.WorkspaceGrants, current.WorkspaceGrants},
	} {
		left, err := canonicalJSONArray(pair[0])
		if err != nil {
			return false, err
		}
		right, err := canonicalJSONArray(pair[1])
		if err != nil {
			return false, err
		}
		if !bytes.Equal(left, right) {
			return true, nil
		}
	}
	return previous.DisplayName != current.DisplayName || previous.Status != current.Status ||
		previous.Capacity != current.Capacity || previous.Platform != current.Platform ||
		previous.DaemonVersion != current.DaemonVersion || previous.RecommendedVersion != current.RecommendedVersion ||
		previous.ActiveOperations != current.ActiveOperations, nil
}

// markLocalComputersOffline records that no Computer is connected: a newly
// started Agent Service process holds no Runner connection.
func markLocalComputersOffline(ctx context.Context, queries *store.Queries) error {
	computers, err := queries.MarkAgentRuntimeLocalComputersOffline(ctx)
	if err != nil {
		return err
	}
	owners := make([]LocalComputerOwner, len(computers))
	for index, computer := range computers {
		owners[index] = LocalComputerOwner{TenantID: computer.OwnerTenantID, OwnerActorID: computer.OwnerActorID}
	}
	return publishLocalComputerChanges(ctx, queries, owners...)
}

func (s *Service) RemoveLocalComputer(ctx context.Context, input LocalComputerCredentialInput) (string, error) {
	if !validComputerID(input.ComputerID) || !validOwner(input.Owner) {
		return "", ErrInvalid
	}
	return executeLocalComputerTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (string, *LocalComputerOwner, error) {
		row, err := queries.LockAgentRuntimeLocalComputer(ctx, input.ComputerID)
		if isNoRows(err) || (err == nil && (row.OwnerTenantID != input.Owner.TenantID || row.OwnerActorID != input.Owner.OwnerActorID)) {
			return "not_found", nil, nil
		}
		if err != nil {
			return "", nil, err
		}
		if row.Status == "removed" {
			return "already_removed", nil, nil
		}
		assignedAgents, err := queries.CountLocalAgentRegistrationsByComputer(ctx, store.CountLocalAgentRegistrationsByComputerParams{
			TenantID: input.Owner.TenantID, ComputerID: input.ComputerID,
		})
		if err != nil {
			return "", nil, err
		}
		if assignedAgents > 0 {
			return "has_agents", nil, nil
		}
		if err := queries.PurgeAgentRuntimeLocalComputerEnrollmentsByComputer(ctx, input.ComputerID); err != nil {
			return "", nil, err
		}
		if _, err := queries.RemoveAgentRuntimeLocalComputer(ctx, input.ComputerID); err != nil {
			return "", nil, err
		}
		return "removed", &input.Owner, nil
	})
}

func (s *Service) CreateLocalComputerEnrollment(ctx context.Context, input CreateLocalComputerEnrollmentInput) error {
	if !validText(input.EnrollmentID, 8, 128) || !validComputerID(input.ComputerID) ||
		!validDisplayName(input.DisplayName) || !validOwner(input.Owner) || !validText(input.RedirectURI, 1, 2000) ||
		!validText(input.CodeChallenge, 43, 128) || len(input.AuthorizationCodeHash) != sha256.Size || input.ExpiresAt.IsZero() {
		return ErrInvalid
	}
	_, err := executeLocalComputerTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (bool, *LocalComputerOwner, error) {
		now, err := queries.AgentRuntimeDatabaseNow(ctx)
		if err != nil {
			return false, nil, err
		}
		if !now.Valid || !input.ExpiresAt.After(now.Time) {
			return false, nil, ErrInvalid
		}
		if err := requireOwnerActor(ctx, queries, input.Owner); err != nil {
			return false, nil, err
		}
		computer, lockComputerErr := queries.LockAgentRuntimeLocalComputer(ctx, input.ComputerID)
		if input.RenewsExistingComputer {
			if isNoRows(lockComputerErr) {
				return false, nil, ErrNotFound
			}
			if lockComputerErr != nil {
				return false, nil, lockComputerErr
			}
			if computer.OwnerTenantID != input.Owner.TenantID || computer.OwnerActorID != input.Owner.OwnerActorID {
				return false, nil, ErrNotFound
			}
			if computer.Status == "removed" {
				return false, nil, ErrRemoved
			}
		} else if lockComputerErr == nil || !isNoRows(lockComputerErr) {
			if lockComputerErr != nil {
				return false, nil, lockComputerErr
			}
			return false, nil, ErrConflict
		}
		if err := queries.DeletePendingAgentRuntimeLocalComputerEnrollments(ctx, store.DeletePendingAgentRuntimeLocalComputerEnrollmentsParams{
			TenantID: input.Owner.TenantID, OwnerActorID: input.Owner.OwnerActorID,
		}); err != nil {
			return false, nil, err
		}
		_, err = queries.InsertAgentRuntimeLocalComputerEnrollment(ctx, store.InsertAgentRuntimeLocalComputerEnrollmentParams{
			EnrollmentID: input.EnrollmentID, TenantID: input.Owner.TenantID, OwnerActorID: input.Owner.OwnerActorID,
			ComputerID: input.ComputerID, RenewsExistingComputer: input.RenewsExistingComputer,
			DisplayName: strings.TrimSpace(input.DisplayName), RedirectUri: input.RedirectURI,
			CodeChallenge: input.CodeChallenge, AuthorizationCodeHash: append([]byte(nil), input.AuthorizationCodeHash...),
			ExpiresAt: timestamptz(input.ExpiresAt),
		})
		return true, nil, err
	})
	return err
}

func (s *Service) ConsumeLocalComputerEnrollment(ctx context.Context, input ConsumeLocalComputerEnrollmentInput) (ConsumeLocalComputerEnrollmentResult, error) {
	if !validText(input.EnrollmentID, 8, 128) || !validText(input.RedirectURI, 1, 2000) ||
		!validText(input.CodeChallenge, 43, 128) || len(input.AuthorizationCodeHash) != sha256.Size {
		return ConsumeLocalComputerEnrollmentResult{}, ErrInvalid
	}
	return executeLocalComputerTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (ConsumeLocalComputerEnrollmentResult, *LocalComputerOwner, error) {
		row, err := queries.LockAgentRuntimeLocalComputerEnrollment(ctx, input.EnrollmentID)
		if isNoRows(err) {
			return ConsumeLocalComputerEnrollmentResult{Available: false}, nil, nil
		}
		if err != nil {
			return ConsumeLocalComputerEnrollmentResult{}, nil, err
		}
		now, err := queries.AgentRuntimeDatabaseNow(ctx)
		if err != nil {
			return ConsumeLocalComputerEnrollmentResult{}, nil, err
		}
		if !enrollmentExchangeMatches(row, input) || !now.Valid || row.ExpiresAt.Time.Before(now.Time) {
			if !row.ExchangedAt.Valid {
				if err := queries.DeleteAgentRuntimeLocalComputerEnrollment(ctx, input.EnrollmentID); err != nil {
					return ConsumeLocalComputerEnrollmentResult{}, nil, err
				}
			}
			return ConsumeLocalComputerEnrollmentResult{Available: false}, nil, nil
		}
		if row.ExchangedAt.Valid {
			result, err := replayLocalComputerEnrollment(ctx, queries, row)
			return result, nil, err
		}
		enrollment, err := localComputerEnrollmentFromRow(row)
		if err != nil {
			return ConsumeLocalComputerEnrollmentResult{}, nil, err
		}
		computer, available, err := exchangeLocalComputerEnrollment(ctx, queries, enrollment)
		if err != nil {
			return ConsumeLocalComputerEnrollmentResult{}, nil, err
		}
		if !available {
			if err := queries.DeleteAgentRuntimeLocalComputerEnrollment(ctx, input.EnrollmentID); err != nil {
				return ConsumeLocalComputerEnrollmentResult{}, nil, err
			}
			return ConsumeLocalComputerEnrollmentResult{Available: false}, nil, nil
		}
		row, err = queries.ConsumeAgentRuntimeLocalComputerEnrollment(ctx, store.ConsumeAgentRuntimeLocalComputerEnrollmentParams{
			ExchangedGeneration: computer.CredentialGeneration, EnrollmentID: input.EnrollmentID,
		})
		if isNoRows(err) {
			return ConsumeLocalComputerEnrollmentResult{}, nil, ErrConflict
		}
		if err != nil {
			return ConsumeLocalComputerEnrollmentResult{}, nil, err
		}
		result, err := consumedLocalComputerEnrollmentResult(row, computer, computer.CredentialGeneration)
		return result, &computer.Owner, err
	})
}

func replayLocalComputerEnrollment(
	ctx context.Context,
	queries *store.Queries,
	row store.LocalComputerEnrollment,
) (ConsumeLocalComputerEnrollmentResult, error) {
	if !row.ExchangedGeneration.Valid || !row.RequestedComputerID.Valid {
		return ConsumeLocalComputerEnrollmentResult{Available: false}, nil
	}
	computerRow, err := queries.GetAgentRuntimeLocalComputer(ctx, row.RequestedComputerID.String)
	if isNoRows(err) || (err == nil && computerRow.Status == "removed") {
		return ConsumeLocalComputerEnrollmentResult{Available: false}, nil
	}
	if err != nil {
		return ConsumeLocalComputerEnrollmentResult{}, err
	}
	computer, err := localComputerFromRow(computerRow)
	if err != nil {
		return ConsumeLocalComputerEnrollmentResult{}, err
	}
	return consumedLocalComputerEnrollmentResult(row, computer, row.ExchangedGeneration.Int64)
}

func exchangeLocalComputerEnrollment(
	ctx context.Context,
	queries *store.Queries,
	enrollment LocalComputerEnrollment,
) (LocalComputer, bool, error) {
	row, err := queries.LockAgentRuntimeLocalComputer(ctx, enrollment.ComputerID)
	if enrollment.RenewsExistingComputer {
		if isNoRows(err) || (err == nil && (row.Status == "removed" ||
			row.OwnerTenantID != enrollment.Owner.TenantID || row.OwnerActorID != enrollment.Owner.OwnerActorID)) {
			return LocalComputer{}, false, nil
		}
		if err != nil {
			return LocalComputer{}, false, err
		}
		row, err = queries.RotateAgentRuntimeLocalComputerCredential(ctx, store.RotateAgentRuntimeLocalComputerCredentialParams{
			DisplayName: enrollment.DisplayName, ComputerID: enrollment.ComputerID,
		})
		if isNoRows(err) {
			return LocalComputer{}, false, nil
		}
		if err != nil {
			return LocalComputer{}, false, err
		}
		computer, err := localComputerFromRow(row)
		return computer, true, err
	}
	if err == nil {
		return LocalComputer{}, false, nil
	}
	if !isNoRows(err) {
		return LocalComputer{}, false, err
	}
	row, err = queries.InsertAgentRuntimeLocalComputer(ctx, store.InsertAgentRuntimeLocalComputerParams{
		ComputerID: enrollment.ComputerID, DisplayName: enrollment.DisplayName,
		OwnerTenantID: enrollment.Owner.TenantID, OwnerActorID: enrollment.Owner.OwnerActorID,
	})
	if err != nil {
		return LocalComputer{}, false, err
	}
	computer, err := localComputerFromRow(row)
	return computer, true, err
}

func consumedLocalComputerEnrollmentResult(
	row store.LocalComputerEnrollment,
	computer LocalComputer,
	generation int64,
) (ConsumeLocalComputerEnrollmentResult, error) {
	enrollment, err := localComputerEnrollmentFromRow(row)
	if err != nil {
		return ConsumeLocalComputerEnrollmentResult{}, err
	}
	return ConsumeLocalComputerEnrollmentResult{
		Available: true, Enrollment: &enrollment, Computer: &computer, CredentialGeneration: &generation,
	}, nil
}

// isDaemonIdentityInUse reports that another Computer that was not removed
// already holds the Daemon Identity, which the unique Daemon ID index rejects.
func isDaemonIdentityInUse(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505" &&
		postgresError.ConstraintName == "local_computers_daemon_id_idx"
}

// executeLocalComputerTx commits a Computer write and tells its owner's Tenant
// when the operation reports a change the Web shows.
func executeLocalComputerTx[T any](
	ctx context.Context,
	service *Service,
	operation func(context.Context, pgx.Tx, *store.Queries) (T, *LocalComputerOwner, error),
) (T, error) {
	var zero T
	if service == nil || service.pool == nil {
		return zero, ErrInvalid
	}
	tx, err := service.pool.Begin(ctx)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	result, changed, err := operation(ctx, tx, queries)
	if err != nil {
		return zero, err
	}
	if changed != nil {
		if err := publishLocalComputerChanges(ctx, queries, *changed); err != nil {
			return zero, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return zero, err
	}
	return result, nil
}

// publishLocalComputerChanges tells each owner's Tenant that its Computers and
// Agent availability changed. Every owner must be a Human with an Account.
func publishLocalComputerChanges(ctx context.Context, queries *store.Queries, owners ...LocalComputerOwner) error {
	tenantIDs := make([]string, 0, len(owners))
	for _, owner := range owners {
		if err := requireOwnerActor(ctx, queries, owner); err != nil {
			return err
		}
		if !slices.Contains(tenantIDs, owner.TenantID) {
			tenantIDs = append(tenantIDs, owner.TenantID)
		}
	}
	slices.Sort(tenantIDs)
	for _, tenantID := range tenantIDs {
		for _, change := range []string{"tenant.local-computers.changed", "tenant.agent-availability.changed"} {
			if err := account.PublishTenantChange(ctx, queries, tenantID, change); err != nil {
				return err
			}
		}
	}
	return nil
}

func localComputerFromRow(row store.LocalComputer) (LocalComputer, error) {
	runtimes, err := activeRuntimeProjection(row.RuntimeInventory, false)
	if err != nil {
		return LocalComputer{}, err
	}
	diagnostics, err := ActiveLocalRuntimeDiagnostics(row.RuntimeDiagnostics)
	if err != nil {
		return LocalComputer{}, err
	}
	grants, err := canonicalJSONArray(row.WorkspaceGrants)
	if err != nil {
		return LocalComputer{}, err
	}
	result := LocalComputer{
		ComputerID: row.ComputerID, DisplayName: row.DisplayName, Status: row.Status,
		Owner:    LocalComputerOwner{TenantID: row.OwnerTenantID, OwnerActorID: row.OwnerActorID},
		Platform: row.Platform.String, CredentialGeneration: row.CredentialGeneration, Runtimes: runtimes,
		RuntimeDiagnostics: diagnostics, WorkspaceGrants: grants,
	}
	if row.LastSeenAt.Valid {
		value := row.LastSeenAt.Time
		result.LastSeenAt = &value
	}
	if row.Capacity.Valid {
		value := row.Capacity.Int32
		result.Capacity = &value
	}
	return result, nil
}

func requireOwnerActor(ctx context.Context, queries *store.Queries, owner LocalComputerOwner) error {
	actor, err := queries.GetActor(ctx, store.GetActorParams{ID: owner.OwnerActorID, TenantID: owner.TenantID})
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if actor.Kind != "human" || !actor.AccountID.Valid || actor.AccountID.String == "" {
		return ErrNotFound
	}
	return nil
}

func canonicalJSONArray(raw json.RawMessage) ([]byte, error) {
	if len(raw) == 0 {
		return nil, ErrInvalid
	}
	var value []any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, ErrInvalid
	}
	canonical, err := canonicalJSON(value)
	if err != nil {
		return nil, ErrInvalid
	}
	return canonical, nil
}

// IsSupportedLocalRuntimeType excludes historical providers from active reads and admission.
func IsSupportedLocalRuntimeType(runtimeType string) bool {
	return slices.Contains([]string{"codex", "claude", "pi"}, runtimeType)
}

func localComputerEnrollmentFromRow(row store.LocalComputerEnrollment) (LocalComputerEnrollment, error) {
	if !row.RequestedComputerID.Valid || !row.ExpiresAt.Valid {
		return LocalComputerEnrollment{}, ErrInvalid
	}
	return LocalComputerEnrollment{
		EnrollmentID: row.EnrollmentID, ComputerID: row.RequestedComputerID.String, DisplayName: row.DisplayName,
		Owner:     LocalComputerOwner{TenantID: row.TenantID, OwnerActorID: row.OwnerActorID},
		ExpiresAt: row.ExpiresAt.Time, RenewsExistingComputer: row.RenewsExistingComputer,
	}, nil
}

func enrollmentExchangeMatches(row store.LocalComputerEnrollment, input ConsumeLocalComputerEnrollmentInput) bool {
	return row.RedirectUri == input.RedirectURI && row.CodeChallenge == input.CodeChallenge &&
		bytes.Equal(row.AuthorizationCodeHash, input.AuthorizationCodeHash)
}

func validComputerID(value string) bool {
	return computerIDPattern.MatchString(value)
}

func validDisplayName(value string) bool {
	trimmed := strings.TrimSpace(value)
	return len(trimmed) >= 1 && len([]rune(trimmed)) <= 120
}

func validOwner(owner LocalComputerOwner) bool {
	return validText(owner.TenantID, 1, 256) && validText(owner.OwnerActorID, 1, 256)
}

func validText(value string, minimum, maximum int) bool {
	length := len([]rune(strings.TrimSpace(value)))
	return length >= minimum && length <= maximum
}

func optionalInt4(value *int32) pgtype.Int4 {
	if value == nil {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: *value, Valid: true}
}

func timestamptz(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value, Valid: true}
}

// Filter at read time; persisted historical observations remain untouched.
func activeRuntimeProjection(raw json.RawMessage, diagnostics bool) (json.RawMessage, error) {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, ErrInvalid
	}
	result := make([]json.RawMessage, 0, len(values))
	for _, value := range values {
		var runtimeType string
		if diagnostics {
			var diagnostic struct {
				Type    string          `json:"type"`
				Runtime json.RawMessage `json:"runtime"`
			}
			if err := json.Unmarshal(value, &diagnostic); err != nil {
				return nil, ErrInvalid
			}
			runtimeType = diagnostic.Type
			if runtimeType == "" && len(diagnostic.Runtime) > 0 {
				if err := json.Unmarshal(diagnostic.Runtime, &runtimeType); err != nil {
					return nil, ErrInvalid
				}
			}
		} else if err := json.Unmarshal(value, &runtimeType); err != nil {
			// Observations also retain object inventory entries, including metadata.
			var runtime struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(value, &runtime); err != nil {
				return nil, ErrInvalid
			}
			runtimeType = runtime.Type
		}
		if IsSupportedLocalRuntimeType(runtimeType) {
			result = append(result, value)
		}
	}
	return canonicalJSON(result)
}

// ActiveLocalRuntimeDiagnostics filters historical provider entries before decoding
// their provider-specific fields, without changing the persisted observation.
func ActiveLocalRuntimeDiagnostics(raw json.RawMessage) (json.RawMessage, error) {
	return activeRuntimeProjection(raw, true)
}
