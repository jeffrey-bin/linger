package taskexecution

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomattention"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type Service struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) CreateManagedGeneration(ctx context.Context, input CreateManagedGenerationInput) (CreateManagedGenerationResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	defer tx.Rollback(ctx)
	result, err := CreateManagedGeneration(ctx, tx, store.New(tx), input)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	return result, nil
}

// CreateManagedGeneration promotes an existing Task inside the caller's transaction.
// The transaction form lets Task creation persist the WorkItem, Room, execution snapshot,
// initial effect, and first lifecycle fact atomically.
func CreateManagedGeneration(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	input CreateManagedGenerationInput,
) (CreateManagedGenerationResult, error) {
	if tx == nil || queries == nil || strings.TrimSpace(input.TaskID) == "" {
		return CreateManagedGenerationResult{}, ErrInvalid
	}
	normalizedSpec, specJSON, specHash, err := NormalizeRunSpecV1(input.RunSpec)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	input.RunSpec = normalizedSpec
	locked, err := queries.LockUnmanagedTaskForExecution(ctx, input.TaskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateManagedGenerationResult{}, ErrConflict
	}
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	if locked.ArchivedAt.Valid || locked.State == "resolved" ||
		input.TenantID != "" && input.TenantID != locked.TenantID ||
		input.EventRoomID != "" && input.EventRoomID != locked.EventRoomID ||
		input.WorkItemVersion != 0 && input.WorkItemVersion != locked.Version {
		return CreateManagedGenerationResult{}, ErrConflict
	}
	participant, err := validateParticipant(ctx, queries, locked.TenantID, input)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	recipients := []string{participant.ActorID}
	if (input.CoordinatorActorID == "") != (input.CoordinatorContextKey == "") {
		return CreateManagedGenerationResult{}, ErrInvalid
	}
	if input.CoordinatorContextKey != "" {
		coordinatorRef, decodeErr := agentruntimestate.DecodeContextKey(input.CoordinatorContextKey)
		if decodeErr != nil || coordinatorRef.Kind != "meta" {
			return CreateManagedGenerationResult{}, ErrInvalid
		}
		// The key only routes coordinator notifications; current registration owns
		// the business identity independently of any Context residency or Local Run.
		coordinator, getErr := queries.GetAgentRegistrationForUpdate(ctx, store.GetAgentRegistrationForUpdateParams{
			ActorID: input.CoordinatorActorID, TenantID: locked.TenantID,
		})
		if errors.Is(getErr, pgx.ErrNoRows) {
			return CreateManagedGenerationResult{}, ErrConflict
		}
		if getErr != nil {
			return CreateManagedGenerationResult{}, getErr
		}
		if coordinator.Status != "active" || !coordinator.AgentManagementID.Valid || coordinator.AgentManagementID.String != coordinatorRef.AgentID {
			return CreateManagedGenerationResult{}, ErrConflict
		}
	}
	inputManifest, err := canonicalObject(input.InitialInputManifest)
	if err != nil {
		return CreateManagedGenerationResult{}, ErrInvalid
	}
	var frozenInputManifest map[string]any
	if json.Unmarshal(inputManifest, &frozenInputManifest) != nil {
		return CreateManagedGenerationResult{}, ErrInvalid
	}
	if roomID, exists := frozenInputManifest["room_id"]; exists && roomID != locked.EventRoomID {
		return CreateManagedGenerationResult{}, ErrConflict
	}
	frozenInputManifest["room_id"] = locked.EventRoomID
	inputManifest, _, err = canonicalHash(frozenInputManifest)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	initialMessage, err := normalizeTurnMessage(input.InitialMessage)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	now, err := queries.TaskExecutionDatabaseNow(ctx)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	capability, err := randomToken(32)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	attemptID := newID("task_attempt_")
	effectID := newID("task_effect_")
	generation := int64(1)
	// Meta Inbox/callback inserts take Account and projection locks before
	// appendExecutionEvent. Include known card/link Rooms before those writes.
	if err := queries.LockWorkItemDeliveryRooms(ctx, store.LockWorkItemDeliveryRoomsParams{
		TenantID: locked.TenantID, WorkItemID: input.TaskID, OriginRoomID: locked.EventRoomID,
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	if _, err := queries.InsertTaskExecutionGeneration(ctx, store.InsertTaskExecutionGenerationParams{
		TaskID: input.TaskID, TenantID: locked.TenantID, Generation: generation,
		SourceKey: optionalText(input.SourceKey), ResultAgentActorID: normalizedSpec.ResultAgentActorID,
		Spec: specJSON, SpecHash: specHash,
		CoordinatorActorID:    optionalText(input.CoordinatorActorID),
		CoordinatorContextKey: optionalText(input.CoordinatorContextKey),
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	if input.CoordinatorActorID != "" {
		if err := queries.EnsureTaskMetaCallback(ctx, store.EnsureTaskMetaCallbackParams{
			TaskID: input.TaskID, TenantID: locked.TenantID, Generation: generation,
			CoordinatorActorID:    input.CoordinatorActorID,
			CoordinatorContextKey: input.CoordinatorContextKey,
		}); err != nil {
			return CreateManagedGenerationResult{}, err
		}
	}
	if _, err := queries.InsertTaskExecutionParticipant(ctx, store.InsertTaskExecutionParticipantParams{
		TaskID: input.TaskID, TenantID: locked.TenantID, Generation: generation,
		ActorID:             participant.ActorID,
		AgentManagementID:   participant.AgentManagementID,
		ExecutionContextRef: participant.ExecutionContextRef,
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	if err := queries.EnsureTaskMetaInbox(ctx, store.EnsureTaskMetaInboxParams{
		TaskID: input.TaskID, TenantID: locked.TenantID, AgentActorID: participant.ActorID,
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	wakeAuthorActorID := input.CausedByActorID
	if wakeAuthorActorID == "" {
		wakeAuthorActorID = locked.UpdatedByActorID
	}
	wakes, err := AppendParticipantMetaWakes(
		ctx, queries, input.TaskID, locked.TenantID, wakeAuthorActorID,
		recipients, initialMessage,
	)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	inputManifest, err = FreezeParticipantWakeManifest(inputManifest, initialMessage, wakes)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	deadline := pgtype.Timestamptz{Time: now.Time.Add(time.Duration(normalizedSpec.AttemptPolicy.TimeoutSeconds) * time.Second), Valid: true}
	if _, err := queries.InsertTaskAttempt(ctx, store.InsertTaskAttemptParams{
		ID: attemptID, TaskID: input.TaskID, TenantID: locked.TenantID, Generation: generation,
		AttemptNumber: 1, RuntimeGenerationKey: newID("runtime_generation_"), Status: "running",
		CurrentInputRevision: 1, DeadlineAt: deadline,
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	recipientJSON, _ := json.Marshal(recipients)
	effectIDs, _ := json.Marshal([]string{effectID})
	if _, err := queries.InsertTaskInputRevision(ctx, store.InsertTaskInputRevisionParams{
		TaskID: input.TaskID, TenantID: locked.TenantID, Generation: generation,
		AttemptID: attemptID, InputRevision: 1, Cause: "creation",
		RecipientActorIds: recipientJSON, InputManifest: inputManifest,
		MessageEffectIds: effectIDs, CapabilityHash: tokenHash(capability),
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	effectPayload, err := NewRoutedSubmitTurnEffectPayload(
		attemptID, 1, recipients, inputManifest, initialMessage, wakes, capability,
	)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	effectJSON, effectHash, err := canonicalHash(effectPayload)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	rootOperationID := fmt.Sprintf("task:%s:g:%d:attempt:%s:input:1", input.TaskID, generation, attemptID)
	if _, err := queries.InsertTaskEffect(ctx, store.InsertTaskEffectParams{
		ID: effectID, TaskID: input.TaskID, TenantID: locked.TenantID, Generation: generation,
		RootOperationID: rootOperationID, EffectKey: rootOperationID + ":submit",
		Operation: "submit_agent_turn", OwnerID: input.TaskID,
		Payload: effectJSON, PayloadHash: effectHash, RootPayloadHash: effectHash,
		DispatchSequence: 1, Status: "pending",
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	factPayload := map[string]any{"attempt_id": attemptID, "input_revision": int64(1), "effect_id": effectID}
	if err := insertFact(ctx, queries, factInput{
		TaskID: input.TaskID, TenantID: locked.TenantID, Generation: generation,
		Revision: 1, Kind: "TASK_EXECUTION_CHANGED", Status: "running",
		ControlSettledRevision: 0, Payload: factPayload, CausedByActorID: input.CausedByActorID,
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	if _, err := queries.PromoteTaskToManagedExecution(ctx, store.PromoteTaskToManagedExecutionParams{
		WorkItemState: "in_progress", SourceKey: optionalText(input.SourceKey),
		Generation: generation, ExecutionStatus: "running", ExecutionRevision: 1,
		TaskID: input.TaskID, TenantID: locked.TenantID,
	}); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	eventActorID := input.CausedByActorID
	if eventActorID == "" {
		eventActorID = locked.UpdatedByActorID
	}
	if err := appendExecutionEvent(ctx, queries, locked.TenantID, locked.EventRoomID, input.TaskID, eventActorID, locked.Version, 1, "running"); err != nil {
		return CreateManagedGenerationResult{}, err
	}
	execution, err := getExecution(ctx, queries, input.TaskID)
	if err != nil {
		return CreateManagedGenerationResult{}, err
	}
	return CreateManagedGenerationResult{
		Execution: execution, InitialCapability: capability, InitialEffectID: effectID,
	}, nil
}

func (s *Service) GetExecution(ctx context.Context, taskID string) (Execution, error) {
	if strings.TrimSpace(taskID) == "" {
		return Execution{}, ErrInvalid
	}
	return getExecution(ctx, store.New(s.pool), taskID)
}

// GetExecutionForHuman authorizes through the Work Item visibility rule, then
// loads the Task ledger from one repeatable-read snapshot for product queries.
func (s *Service) GetExecutionForHuman(
	ctx context.Context,
	accountID, taskID string,
) (Execution, error) {
	if strings.TrimSpace(accountID) == "" || strings.TrimSpace(taskID) == "" {
		return Execution{}, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Execution{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	item, err := queries.GetWorkItemForHuman(ctx, store.GetWorkItemForHumanParams{
		ID: taskID, AccountID: accountID,
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (item.Kind != "task" || !item.TaskExecutionGeneration.Valid)) {
		return Execution{}, ErrNotFound
	}
	if err != nil {
		return Execution{}, err
	}
	execution, err := getExecution(ctx, queries, taskID)
	if err != nil {
		return Execution{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Execution{}, err
	}
	return execution, nil
}

// ResolveAgentParticipantTaskByWorkRoom resolves Task execution identity from
// the current frozen participant generation. Mutable Work Item relations are
// deliberately absent from the authority query.
func (s *Service) ResolveAgentParticipantTaskByWorkRoom(
	ctx context.Context,
	agentManagementID, workRoomID string,
) (ParticipantTaskResolution, error) {
	if strings.TrimSpace(agentManagementID) == "" || strings.TrimSpace(workRoomID) == "" {
		return ParticipantTaskResolution{}, ErrInvalid
	}
	row, err := store.New(s.pool).ResolveAgentParticipantTaskByWorkRoom(
		ctx,
		store.ResolveAgentParticipantTaskByWorkRoomParams{
			AgentManagementID: agentManagementID,
			WorkRoomID:        workRoomID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ParticipantTaskResolution{}, ErrNotFound
	}
	if err != nil {
		return ParticipantTaskResolution{}, err
	}
	return ParticipantTaskResolution{
		TaskID:              row.TaskID,
		WorkRoomID:          row.WorkRoomID,
		ExecutionGeneration: row.ExecutionGeneration,
	}, nil
}

// validateParticipant checks the Task's only participant: the AlterEgo of
// the run spec's result Agent, whose registration is still active.
func validateParticipant(
	ctx context.Context,
	queries *store.Queries,
	tenantID string,
	input CreateManagedGenerationInput,
) (ParticipantInput, error) {
	participant := input.Participant
	participant.ActorID = strings.TrimSpace(participant.ActorID)
	participant.AgentManagementID = strings.TrimSpace(participant.AgentManagementID)
	if participant.ActorID == "" || participant.AgentManagementID == "" ||
		participant.ActorID != input.RunSpec.ResultAgentActorID {
		return ParticipantInput{}, ErrInvalid
	}
	if len(participant.ExecutionContextRef) == 0 {
		participant.ExecutionContextRef = json.RawMessage(`{}`)
	}
	if _, err := canonicalObject(participant.ExecutionContextRef); err != nil {
		return ParticipantInput{}, ErrInvalid
	}
	resolved, err := queries.ResolveTaskParticipant(ctx, store.ResolveTaskParticipantParams{
		ActorID: participant.ActorID, TenantID: tenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ParticipantInput{}, ErrForbidden
	}
	if err != nil {
		return ParticipantInput{}, err
	}
	if resolved.Kind != "agent" || !resolved.AgentManagementID.Valid ||
		resolved.RegistrationStatus != "active" ||
		resolved.AgentManagementID.String != participant.AgentManagementID {
		return ParticipantInput{}, ErrForbidden
	}
	return participant, nil
}

type factInput struct {
	TaskID, TenantID, Kind, Status, ReasonCode, CausedByActorID   string
	Generation, Revision, ControlSettledRevision, ControlRevision int64
	SourceOperationID                                             string
	Payload                                                       any
}

func insertFact(ctx context.Context, queries *store.Queries, input factInput) error {
	payload, payloadHash, err := canonicalHash(input.Payload)
	if err != nil {
		return err
	}
	_, err = queries.InsertTaskExecutionFact(ctx, store.InsertTaskExecutionFactParams{
		ID: newID("task_fact_"), TaskID: input.TaskID, TenantID: input.TenantID,
		Generation: input.Generation, ExecutionRevision: input.Revision,
		FactKind: input.Kind, ExecutionStatus: input.Status,
		ControlSettledRevision: input.ControlSettledRevision,
		ControlRevision:        optionalInt(input.ControlRevision), SourceOperationID: optionalText(input.SourceOperationID),
		ReasonCode: optionalText(input.ReasonCode),
		Payload:    payload, PayloadHash: payloadHash, CausedByActorID: optionalText(input.CausedByActorID),
	})
	return err
}

func appendExecutionEvent(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID, taskID, actorID string,
	workItemVersion, executionRevision int64,
	status string,
) error {
	if roomID == "" || actorID == "" {
		return ErrInvalid
	}
	// Tenant fanout follows this Room event. Prelock its full Account set
	// before the narrower Room delivery can acquire sequence locks.
	if err := queries.LockTenantDeliveryAccountsForRooms(ctx, store.LockTenantDeliveryAccountsForRoomsParams{
		TenantID: tenantID, RoomIds: []string{roomID},
	}); err != nil {
		return err
	}
	roomSeq, err := roomevent.Append(ctx, queries, roomevent.Input{
		TenantID: tenantID, RoomID: roomID, EventType: "work_item.changed",
		ActorID: actorID, ResourceID: taskID,
		Payload: map[string]any{
			"kind": "work_item.changed", "work_item_id": taskID, "version": workItemVersion,
			"task_execution_revision": executionRevision, "task_execution_status": status,
		},
	})
	if err != nil {
		return err
	}
	return roomattention.AppendForTenantHumans(ctx, queries, roomattention.RoomSummaryUpdate{
		TenantID: tenantID, RoomID: roomID, RoomSeq: roomSeq, Reason: "work_item.changed",
	})
}

func canonicalObject(raw json.RawMessage) ([]byte, error) {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	canonical, value, err := canonicalRaw(raw)
	if err != nil {
		return nil, err
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, ErrInvalid
	}
	return canonical, nil
}

func canonicalRaw(raw json.RawMessage) ([]byte, any, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, nil, err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return nil, nil, ErrInvalid
	}
	canonical, err := json.Marshal(value)
	return canonical, value, err
}

func canonicalHash(value any) ([]byte, []byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, nil, err
	}
	digest := sha256.Sum256(encoded)
	return encoded, digest[:], nil
}

func newID(prefix string) string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(value)
}

func randomToken(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func tokenHash(value string) []byte {
	digest := sha256.Sum256([]byte(value))
	return digest[:]
}

func optionalText(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}

func optionalInt(value int64) pgtype.Int8 {
	return pgtype.Int8{Int64: value, Valid: value > 0}
}
