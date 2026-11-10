package agentruntimestate

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func EncodeContextRef(ref ContextRef) (string, error) {
	if strings.TrimSpace(ref.AgentID) == "" {
		return "", ErrInvalid
	}
	var parts []string
	switch ref.Kind {
	case "meta":
		if strings.TrimSpace(ref.RoomID) == "" || ref.TaskID != "" || ref.DocumentID != "" {
			return "", ErrInvalid
		}
		parts = []string{"meta", ref.AgentID, "room", ref.RoomID}
	case "alter_ego":
		if strings.TrimSpace(ref.TaskID) == "" || ref.RoomID != "" || ref.DocumentID != "" {
			return "", ErrInvalid
		}
		parts = []string{"alter_ego", ref.AgentID, ref.TaskID}
	case "document":
		if strings.TrimSpace(ref.DocumentID) == "" || ref.TaskID != "" || ref.RoomID != "" {
			return "", ErrInvalid
		}
		parts = []string{"document", ref.AgentID, ref.DocumentID}
	default:
		return "", ErrInvalid
	}
	encoded, err := json.Marshal(parts)
	return string(encoded), err
}

func DecodeContextKey(key string) (ContextRef, error) {
	var parts []string
	if json.Unmarshal([]byte(key), &parts) != nil {
		return ContextRef{}, ErrInvalid
	}
	var ref ContextRef
	switch {
	case len(parts) == 4 && parts[0] == "meta" && parts[2] == "room":
		ref = ContextRef{Kind: "meta", AgentID: parts[1], RoomID: parts[3]}
	case len(parts) == 3 && parts[0] == "alter_ego":
		ref = ContextRef{Kind: "alter_ego", AgentID: parts[1], TaskID: parts[2]}
	case len(parts) == 3 && parts[0] == "document":
		ref = ContextRef{Kind: "document", AgentID: parts[1], DocumentID: parts[2]}
	default:
		return ContextRef{}, ErrInvalid
	}
	canonical, err := EncodeContextRef(ref)
	if err != nil || canonical != key {
		return ContextRef{}, ErrInvalid
	}
	return ref, nil
}

// EnsurePerRoomMetaContexts applies the default per-Room topology to every
// current Room membership. Existing Contexts are rebound only for a new
// membership epoch, preserving their RuntimeSession and native thread.
// A Task work Room is not a per-Room Meta: an existing Context there is
// terminated so store sync stops activating it.
func EnsurePerRoomMetaContexts(ctx context.Context, queries *store.Queries, agentActorID string) error {
	_, err := ensurePerRoomMetaContexts(ctx, queries, agentActorID)
	return err
}

func ensurePerRoomMetaContexts(
	ctx context.Context,
	queries *store.Queries,
	agentActorID string,
) ([]EnsureContextResult, error) {
	if queries == nil || strings.TrimSpace(agentActorID) == "" {
		return nil, ErrInvalid
	}
	if err := retireWorkRoomPerRoomMetaContexts(ctx, queries, agentActorID); err != nil {
		return nil, err
	}
	candidates, err := queries.ListAgentPerRoomMetaContextCandidates(ctx, agentActorID)
	if err != nil {
		return nil, err
	}
	results := make([]EnsureContextResult, 0, len(candidates))
	for _, candidate := range candidates {
		if !candidate.AgentManagementID.Valid {
			return nil, ErrConflict
		}
		contextKey, err := EncodeContextRef(ContextRef{
			Kind: "meta", AgentID: candidate.AgentManagementID.String, RoomID: candidate.RoomID,
		})
		if err != nil {
			return nil, err
		}
		row, err := queries.GetAgentExecutionContext(ctx, contextKey)
		if err != nil && !isNoRows(err) {
			return nil, err
		}
		inserted := int64(0)
		// Existing Contexts with the current membership epoch need only a read.
		// Even a no-op INSERT/UPSERT contends with Runtime writes under MVCC.
		if isNoRows(err) || !row.MembershipEpochID.Valid || row.MembershipEpochID.String != candidate.MembershipEpochID {
			inserted, err = queries.InsertAgentExecutionContext(ctx, store.InsertAgentExecutionContextParams{
				ContextKey: contextKey, ContextKind: "meta", TaskID: optionalText(""),
				TargetResidency: "suspended", AgentManagementID: candidate.AgentManagementID.String,
				RoomID: optionalText(candidate.RoomID),
			})
			if err != nil {
				return nil, err
			}
			if inserted == 0 {
				_, err = queries.UpsertAgentPerRoomMetaContext(ctx, store.UpsertAgentPerRoomMetaContextParams{
					ContextKey: contextKey, TenantID: candidate.TenantID,
					AgentActorID: candidate.AgentActorID, AgentManagementID: candidate.AgentManagementID.String,
					RoomID: candidate.RoomID, MembershipEpochID: candidate.MembershipEpochID,
				})
				if err != nil {
					return nil, err
				}
			}
			row, err = queries.GetAgentExecutionContext(ctx, contextKey)
			if isNoRows(err) {
				return nil, ErrNotFound
			}
			if err != nil {
				return nil, err
			}
		}
		if row.TenantID != candidate.TenantID || row.AgentActorID != candidate.AgentActorID ||
			row.AgentManagementID != candidate.AgentManagementID.String || row.ContextKind != "meta" ||
			row.TaskID.Valid || !row.RoomID.Valid || row.RoomID.String != candidate.RoomID ||
			!row.MembershipEpochID.Valid || row.MembershipEpochID.String != candidate.MembershipEpochID {
			return nil, ErrConflict
		}
		converted, err := contextFromRow(ctx, queries, row)
		if err != nil {
			return nil, err
		}
		results = append(results, EnsureContextResult{Created: inserted == 1, Context: converted})
	}
	return results, nil
}

func retireWorkRoomPerRoomMetaContexts(
	ctx context.Context,
	queries *store.Queries,
	agentActorID string,
) error {
	contextKeys, err := queries.ListRetirableWorkRoomPerRoomMetaContexts(ctx, agentActorID)
	if err != nil {
		return err
	}
	for _, contextKey := range contextKeys {
		terminated, err := queries.TerminateWorkRoomPerRoomMetaContext(ctx, contextKey)
		if err != nil {
			if isNoRows(err) {
				continue
			}
			return err
		}
		if err := terminateContextRuntimeForDeletion(ctx, queries, terminated); err != nil {
			return err
		}
	}
	return nil
}

// LockContextsForAgentRevocation locks, in one context_key-ordered pass, every
// open Execution Context of the Agent being revoked and the meta Contexts that
// membership revocation in roomIDs suspends. Callers take it after Room
// membership and registration locks and before Room rows, the canonical
// member -> Context -> Room order.
func LockContextsForAgentRevocation(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	agentActorID string,
	roomIDs []string,
) error {
	if queries == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(agentActorID) == "" {
		return ErrInvalid
	}
	_, err := queries.LockOpenAgentExecutionContextsForAgentRevocation(ctx, store.LockOpenAgentExecutionContextsForAgentRevocationParams{
		TenantID: tenantID, AgentActorID: agentActorID,
		RoomIds: slices.Compact(slices.Sorted(slices.Values(roomIDs))),
	})
	return err
}

// TerminateContextsForAgentRevocation closes every remaining open Execution
// Context of a revoked Agent inside the caller's transaction, after
// LockContextsForAgentRevocation. Terminal rows stay untouched, and the rows
// are kept so history and Debug views still see them.
func TerminateContextsForAgentRevocation(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	agentActorID string,
) error {
	if queries == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(agentActorID) == "" {
		return ErrInvalid
	}
	contextKeys, err := queries.TerminateOpenAgentExecutionContextsForAgentRevocation(ctx, store.TerminateOpenAgentExecutionContextsForAgentRevocationParams{
		TenantID: tenantID, AgentActorID: agentActorID,
	})
	if err != nil {
		return err
	}
	for _, contextKey := range contextKeys {
		if err := terminateContextRuntimeForDeletion(ctx, queries, contextKey); err != nil {
			return err
		}
	}
	return nil
}

// terminateContextRuntimeForDeletion runs the Runtime side of a context that was
// just marked context_deleted: cancel its Local Runs and settle its waiting
// inputs.
func terminateContextRuntimeForDeletion(
	ctx context.Context,
	queries *store.Queries,
	contextKey string,
) error {
	runIDs, err := queries.ListUnfinishedAgentContextLocalRuns(ctx, contextKey)
	if err != nil {
		return err
	}
	if _, err := TerminateLocalRuns(ctx, queries, runIDs, json.RawMessage(`{"type":"canceled","reason":"context_deleted"}`)); err != nil {
		return err
	}
	_, err = queries.SettleAgentContextInputsForContextDeletion(ctx, contextKey)
	return err
}

// LockRoomMembershipContexts locks the meta Contexts of agentActorIDs in roomIDs
// in context_key order. Call it after the
// membership row locks and before the first rooms lock or membership write.
// Membership writes fire a trigger that locks rooms, and runtime Context holders
// lock their Context before rooms, so a Context taken later would invert order.
func LockRoomMembershipContexts(ctx context.Context, queries *store.Queries, agentActorIDs, roomIDs []string) error {
	agents := slices.Compact(slices.Sorted(slices.Values(agentActorIDs)))
	rooms := slices.Compact(slices.Sorted(slices.Values(roomIDs)))
	if len(agents) == 0 || len(rooms) == 0 {
		return nil
	}
	return queries.LockMetaContextsForRoomMemberships(ctx, store.LockMetaContextsForRoomMembershipsParams{
		AgentActorIds: agents, RoomIds: rooms,
	})
}

// SuspendRoomContextsForMembershipRevocation closes Runtime authority in the
// same transaction that deletes the membership.
func SuspendRoomContextsForMembershipRevocation(
	ctx context.Context,
	queries *store.Queries,
	agentActorID string,
	roomID string,
	membershipEpochID string,
) error {
	return closeRoomContextsForMembershipRevocation(ctx, queries, agentActorID, roomID, membershipEpochID, false)
}

// TerminateRoomContextsForRoomDeletion closes per-Room Runtime authority
// irreversibly while preserving ordinary leave/rejoin Context continuity.
func TerminateRoomContextsForRoomDeletion(
	ctx context.Context,
	queries *store.Queries,
	agentActorID string,
	roomID string,
	membershipEpochID string,
) error {
	return closeRoomContextsForMembershipRevocation(ctx, queries, agentActorID, roomID, membershipEpochID, true)
}

func closeRoomContextsForMembershipRevocation(
	ctx context.Context,
	queries *store.Queries,
	agentActorID string,
	roomID string,
	membershipEpochID string,
	terminal bool,
) error {
	if queries == nil || strings.TrimSpace(agentActorID) == "" ||
		strings.TrimSpace(roomID) == "" || strings.TrimSpace(membershipEpochID) == "" {
		return ErrInvalid
	}
	var contextKey string
	var err error
	if terminal {
		contextKey, err = queries.TerminatePerRoomMetaContextForRoomDeletion(ctx, store.TerminatePerRoomMetaContextForRoomDeletionParams{
			AgentActorID: agentActorID, RoomID: roomID, MembershipEpochID: membershipEpochID,
		})
	} else {
		contextKey, err = queries.SuspendPerRoomMetaContextForMembershipRevocation(ctx, store.SuspendPerRoomMetaContextForMembershipRevocationParams{
			AgentActorID: agentActorID, RoomID: roomID, MembershipEpochID: membershipEpochID,
		})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return closeContextInputsForMembershipRevocation(ctx, queries, contextKey)
}

// SuspendAlterEgoContextsForTaskTerminal closes Runtime authority in the same
// transaction that makes the Task terminal.
func SuspendAlterEgoContextsForTaskTerminal(
	ctx context.Context,
	queries *store.Queries,
	taskID string,
) error {
	if queries == nil || strings.TrimSpace(taskID) == "" {
		return ErrInvalid
	}
	if _, err := queries.CancelPendingTaskEffectsForTaskTerminal(ctx, taskID); err != nil {
		return err
	}
	contextKeys, err := queries.SuspendAlterEgoContextsForTaskTerminal(ctx, taskID)
	if err != nil {
		return err
	}
	for _, contextKey := range contextKeys {
		runIDs, err := queries.ListUnfinishedAgentContextLocalRuns(ctx, contextKey)
		if err != nil {
			return err
		}
		if _, err := TerminateLocalRuns(ctx, queries, runIDs, json.RawMessage(`{"type":"canceled","reason":"task_terminal"}`)); err != nil {
			return err
		}
		if _, err := queries.SettleAgentContextInputsForTaskTerminal(ctx, contextKey); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) EnsureContext(ctx context.Context, input EnsureContextInput) (EnsureContextResult, error) {
	contextKey, err := EncodeContextRef(input.Ref)
	if err != nil || !validResidency(input.TargetResidency) {
		return EnsureContextResult{}, ErrInvalid
	}
	return executeTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (EnsureContextResult, error) {
		changed, err := queries.InsertAgentExecutionContext(ctx, store.InsertAgentExecutionContextParams{
			ContextKey: contextKey, ContextKind: input.Ref.Kind,
			TaskID: optionalText(input.Ref.TaskID), TargetResidency: input.TargetResidency,
			AgentManagementID: input.Ref.AgentID, RoomID: optionalText(input.Ref.RoomID),
			DocumentID: optionalText(input.Ref.DocumentID),
		})
		if err != nil {
			return EnsureContextResult{}, err
		}
		row, err := queries.GetAgentExecutionContext(ctx, contextKey)
		if isNoRows(err) {
			return EnsureContextResult{}, ErrNotFound
		}
		if err != nil {
			return EnsureContextResult{}, err
		}
		if row.AgentManagementID != input.Ref.AgentID || row.ContextKind != input.Ref.Kind ||
			row.TaskID.String != input.Ref.TaskID || row.RoomID.String != input.Ref.RoomID ||
			row.DocumentID.String != input.Ref.DocumentID {
			return EnsureContextResult{}, ErrConflict
		}
		converted, err := contextFromRow(ctx, queries, row)
		return EnsureContextResult{Created: changed == 1, Context: converted}, err
	})
}

func ensureRegistrationMetaContexts(
	ctx context.Context,
	queries *store.Queries,
	agentManagementID string,
) ([]EnsureContextResult, error) {
	agentManagementID = strings.TrimSpace(agentManagementID)
	if queries == nil || agentManagementID == "" {
		return nil, ErrInvalid
	}
	registration, err := queries.GetMaterializableAgentRuntimeRegistrationByManagementID(ctx, agentManagementID)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return ensurePerRoomMetaContexts(ctx, queries, registration.ActorID)
}

func (s *Service) ReconcileMetaContexts(
	ctx context.Context,
	input ReconcileMetaContextsInput,
) (ReconcileMetaContextsResult, error) {
	if s == nil || s.pool == nil || input.Limit < 1 || input.Limit > 1000 || len(input.Cursor) > 2000 {
		return ReconcileMetaContextsResult{}, ErrInvalid
	}
	afterManagementID, err := decodeMetaContextCursor(input.Cursor)
	if err != nil {
		return ReconcileMetaContextsResult{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReconcileMetaContextsResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	registrations, err := queries.ListMaterializableAgentRuntimeRegistrationsAfter(ctx, store.ListMaterializableAgentRuntimeRegistrationsAfterParams{
		AfterManagementID: afterManagementID, RowLimit: int32(input.Limit + 1),
	})
	if err != nil {
		return ReconcileMetaContextsResult{}, err
	}
	result := ReconcileMetaContextsResult{CreatedContextKeys: []string{}}
	if len(registrations) > input.Limit {
		registrations = registrations[:input.Limit]
		result.NextCursor = encodeMetaContextCursor(registrations[len(registrations)-1])
	}
	for _, agentManagementID := range registrations {
		ensured, err := ensureRegistrationMetaContexts(ctx, queries, agentManagementID)
		if err != nil {
			return ReconcileMetaContextsResult{}, err
		}
		result.ExaminedCount += len(ensured)
		for _, context := range ensured {
			if context.Created {
				result.CreatedCount++
				result.CreatedContextKeys = append(result.CreatedContextKeys, context.Context.ContextKey)
			} else {
				result.ExistingCount++
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ReconcileMetaContextsResult{}, err
	}
	return result, nil
}

func encodeMetaContextCursor(agentManagementID string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(agentManagementID))
}

func decodeMetaContextCursor(cursor string) (string, error) {
	if cursor == "" {
		return "", nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || len(decoded) == 0 || !utf8.Valid(decoded) || encodeMetaContextCursor(string(decoded)) != cursor {
		return "", ErrInvalid
	}
	return string(decoded), nil
}

func (s *Service) GetContext(ctx context.Context, contextKey string) (Context, error) {
	if _, err := DecodeContextKey(contextKey); err != nil || s == nil || s.pool == nil {
		return Context{}, ErrInvalid
	}
	queries := store.New(s.pool)
	row, err := queries.GetAgentExecutionContext(ctx, contextKey)
	if isNoRows(err) {
		return Context{}, ErrNotFound
	}
	if err != nil {
		return Context{}, err
	}
	return contextFromRow(ctx, queries, row)
}

func (s *Service) ListContexts(ctx context.Context, agentID string) ([]Context, error) {
	if s == nil || s.pool == nil {
		return nil, ErrInvalid
	}
	queries := store.New(s.pool)
	var rows []contextRecord
	if strings.TrimSpace(agentID) == "" {
		listed, err := queries.ListRuntimeAgentExecutionContexts(ctx)
		if err != nil {
			return nil, err
		}
		for _, row := range listed {
			rows = append(rows, contextRecord(row))
		}
	} else {
		listed, err := queries.ListRuntimeAgentExecutionContextsByManagementID(ctx, agentID)
		if err != nil {
			return nil, err
		}
		for _, row := range listed {
			rows = append(rows, contextRecord(row))
		}
	}
	return contextsFromRows(ctx, queries, rows)
}

func (s *Service) SetContextResidency(ctx context.Context, input SetContextResidencyInput) (Context, error) {
	if _, err := DecodeContextKey(input.ContextKey); err != nil || input.ExpectedRevision < 1 || !validResidency(input.TargetResidency) {
		return Context{}, ErrInvalid
	}
	return executeTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (Context, error) {
		changed, err := queries.SetAgentExecutionContextResidency(ctx, store.SetAgentExecutionContextResidencyParams{
			TargetResidency: input.TargetResidency, ContextKey: input.ContextKey,
			ExpectedRevision: input.ExpectedRevision,
		})
		if err != nil {
			return Context{}, err
		}
		row, err := queries.GetAgentExecutionContext(ctx, input.ContextKey)
		if isNoRows(err) {
			return Context{}, ErrNotFound
		}
		if err != nil {
			return Context{}, err
		}
		// A repeated change finds the residency it set one revision later.
		if changed != 1 && (row.TargetResidency != input.TargetResidency || row.StateRevision != input.ExpectedRevision+1) {
			return Context{}, ErrConflict
		}
		return contextFromRow(ctx, queries, row)
	})
}

func (s *Service) DeleteContext(ctx context.Context, input DeleteContextInput) (bool, error) {
	if _, err := DecodeContextKey(input.ContextKey); err != nil || input.ExpectedRevision < 1 {
		return false, ErrInvalid
	}
	return executeTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (bool, error) {
		runtimeEventCount, err := queries.GetAgentExecutionContextRuntimeEventCount(ctx, input.ContextKey)
		if err != nil {
			return false, err
		}
		if runtimeEventCount > 0 {
			_, err := queries.TerminateAgentExecutionContextForDeletion(ctx, store.TerminateAgentExecutionContextForDeletionParams{
				ContextKey: input.ContextKey, ExpectedRevision: input.ExpectedRevision,
			})
			if isNoRows(err) {
				existingRow, getErr := queries.GetAgentExecutionContext(ctx, input.ContextKey)
				if isNoRows(getErr) {
					return false, ErrNotFound
				}
				if getErr != nil {
					return false, getErr
				}
				existing, getErr := contextFromRow(ctx, queries, existingRow)
				if getErr != nil {
					return false, getErr
				}
				if existing.TerminalReason == "room_deleted" || existing.TerminalReason == "context_deleted" {
					return true, nil
				}
				return false, ErrConflict
			}
			if err != nil {
				return false, err
			}
			return true, nil
		}
		if _, err := queries.DeleteAgentLocalRunInputsByContext(ctx, input.ContextKey); err != nil {
			return false, err
		}
		changed, err := queries.DeleteAgentExecutionContext(ctx, store.DeleteAgentExecutionContextParams{
			ContextKey: input.ContextKey, ExpectedRevision: input.ExpectedRevision,
		})
		if err != nil {
			return false, err
		}
		if changed != 1 {
			if _, err := queries.GetAgentExecutionContext(ctx, input.ContextKey); isNoRows(err) {
				return false, ErrNotFound
			}
			return false, ErrConflict
		}
		return true, nil
	})
}

func validResidency(value string) bool {
	return value == "active" || value == "suspended"
}

func contextsFromRows(ctx context.Context, queries *store.Queries, rows []contextRecord) ([]Context, error) {
	coordinators, err := readTaskCoordinators(ctx, queries, rows)
	if err != nil {
		return nil, err
	}
	result := make([]Context, 0, len(rows))
	for _, row := range rows {
		converted, err := contextFromRowWithCoordinators(row, coordinators)
		if err != nil {
			return nil, err
		}
		result = append(result, converted)
	}
	return result, nil
}

func contextFromRow(ctx context.Context, queries *store.Queries, row contextRecord) (Context, error) {
	coordinators, err := readTaskCoordinators(ctx, queries, []contextRecord{row})
	if err != nil {
		return Context{}, err
	}
	return contextFromRowWithCoordinators(row, coordinators)
}

type taskCoordinatorKey struct{ tenantID, taskID string }

// readTaskCoordinators batches the frozen coordinator of every listed
// alter_ego Task's current generation.
func readTaskCoordinators(ctx context.Context, queries *store.Queries, rows []contextRecord) (map[taskCoordinatorKey]string, error) {
	taskIDs := make([]string, 0)
	for _, row := range rows {
		if row.ContextKind == "alter_ego" && row.TaskID.Valid {
			taskIDs = append(taskIDs, row.TaskID.String)
		}
	}
	coordinators := make(map[taskCoordinatorKey]string)
	if len(taskIDs) == 0 {
		return coordinators, nil
	}
	found, err := queries.ListTaskCoordinatorContextKeys(ctx, slices.Compact(slices.Sorted(slices.Values(taskIDs))))
	if err != nil {
		return nil, err
	}
	for _, coordinator := range found {
		coordinators[taskCoordinatorKey{coordinator.TenantID, coordinator.TaskID}] = coordinator.CoordinatorContextKey.String
	}
	return coordinators, nil
}

// sharedTaskScope derives the shared Task directory identity. Only a
// Room-bound Meta of the same Agent shares Task files: the origin Room is the
// frozen coordinator's Room, never the Task Room.
func sharedTaskScope(tenantID string, ref ContextRef, coordinators map[taskCoordinatorKey]string) *SharedTaskScope {
	switch ref.Kind {
	case "meta":
		if ref.RoomID == "" {
			return nil
		}
		return &SharedTaskScope{Version: 1, TenantID: tenantID, AgentID: ref.AgentID, OriginRoomID: ref.RoomID, Role: "meta"}
	case "alter_ego":
		coordinatorKey, found := coordinators[taskCoordinatorKey{tenantID, ref.TaskID}]
		if !found {
			return nil
		}
		coordinator, err := DecodeContextKey(coordinatorKey)
		if err != nil || coordinator.Kind != "meta" || coordinator.RoomID == "" || coordinator.AgentID != ref.AgentID {
			return nil
		}
		return &SharedTaskScope{Version: 1, TenantID: tenantID, AgentID: ref.AgentID, OriginRoomID: coordinator.RoomID, Role: "alter_ego", TaskID: ref.TaskID}
	}
	return nil
}

func contextFromRowWithCoordinators(row contextRecord, coordinators map[taskCoordinatorKey]string) (Context, error) {
	ref, err := DecodeContextKey(row.ContextKey)
	if err != nil || ref.AgentID != row.AgentManagementID || ref.Kind != row.ContextKind ||
		ref.TaskID != row.TaskID.String || ref.RoomID != row.RoomID.String ||
		ref.DocumentID != row.DocumentID.String {
		return Context{}, errors.New("stored Agent Execution Context identity is invalid")
	}
	result := Context{
		Ref: ref, ContextKey: row.ContextKey, TenantID: row.TenantID,
		AgentActorID: row.AgentActorID, TargetResidency: row.TargetResidency,
		StateRevision: row.StateRevision, NextInputSequence: row.NextInputSequence,
		SharedTaskScope: sharedTaskScope(row.TenantID, ref, coordinators),
	}
	if ref.Kind == "meta" && ref.RoomID != "" {
		if !row.RoomKind.Valid || (row.RoomKind.String != "direct" && row.RoomKind.String != "collaboration") {
			return Context{}, errors.New("stored Agent Execution Context Room kind is invalid")
		}
		result.RoomKind = row.RoomKind.String
	} else if row.RoomKind.Valid {
		return Context{}, errors.New("stored Agent Execution Context Room kind is invalid")
	}
	if row.TerminalReason.Valid {
		if !row.TerminatedAt.Valid {
			return Context{}, errors.New("stored Agent Execution Context terminal state is invalid")
		}
		result.TerminalReason = row.TerminalReason.String
		terminatedAt := row.TerminatedAt.Time
		result.TerminatedAt = &terminatedAt
	} else if row.TerminatedAt.Valid {
		return Context{}, errors.New("stored Agent Execution Context terminal state is invalid")
	}
	if row.MembershipEpochID.Valid {
		result.MembershipEpochID = row.MembershipEpochID.String
	}
	return result, nil
}
