package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const messageActivityPageLimit = 500

const messageActivityRecordLimit = 10000

type messageActivityIdentity struct {
	callIDs      map[string]struct{}
	providerKind string
	reason       string
	status       httpapi.MessageActivityLogStatus
	turnIDs      map[string]struct{}
}

type messageActivityHistoryReader interface {
	ReadRuntimeHistory(
		context.Context,
		roomagent.RuntimeContextTarget,
		roomagent.RuntimeHistoryReadOptions,
	) (roomagent.RuntimeHistory, error)
}

// runActivitySource is the Run whose native history an activity log reads.
type runActivitySource struct {
	runID        string
	contextKey   string
	tenantID     string
	agentActorID string
	task         bool
	eventOrdinal int64
}

func (s *Service) loadMessageActivityIDs(ctx context.Context, localRunID string, through int64) (map[string]struct{}, bool, error) {
	activityIDs := make(map[string]struct{})
	after := int64(0)
	for after < through {
		rows, err := s.queries.ListPublishedRuntimeActivityIDs(ctx, store.ListPublishedRuntimeActivityIDsParams{
			LocalRunID: localRunID, AfterOrdinal: after, PublishedThroughOrdinal: through, ResultLimit: messageActivityPageLimit,
		})
		if err != nil {
			return nil, false, err
		}
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			activityIDs[row.ActivityID] = struct{}{}
			if len(activityIDs) > messageActivityRecordLimit {
				return activityIDs, true, nil
			}
		}
		next := rows[len(rows)-1].EventOrdinal
		if next <= after {
			break
		}
		after = next
	}
	return activityIDs, false, nil
}

func findMessageActivityIdentity(
	ctx context.Context,
	historyReader messageActivityHistoryReader,
	target roomagent.RuntimeContextTarget,
	activityIDs map[string]struct{},
	operationIDs ...string,
) (messageActivityIdentity, error) {
	identity := messageActivityIdentity{
		callIDs: map[string]struct{}{}, status: httpapi.MessageActivityLogStatusAvailable, turnIDs: map[string]struct{}{},
	}
	cursor, seen := "", map[string]struct{}{}
	for {
		limit := messageActivityPageLimit
		options := roomagent.RuntimeHistoryReadOptions{Limit: &limit}
		if cursor != "" {
			options.Cursor = &cursor
		}
		page, err := historyReader.ReadRuntimeHistory(ctx, target, options)
		if err != nil {
			return messageActivityIdentity{}, err
		}
		identity.providerKind = fallbackProviderKind(page.ProviderKind)
		identity.status = messageActivityStatus(page.Status)
		identity.reason = page.Reason
		if identity.status != httpapi.MessageActivityLogStatusAvailable {
			return identity, nil
		}
		for _, record := range page.Records {
			if record.ToolCallID != "" {
				digest := sha256.Sum256([]byte(record.ToolCallID))
				_, hashed := activityIDs["native-"+hex.EncodeToString(digest[:])]
				_, direct := activityIDs[record.ToolCallID]
				// Local Computer persists a hash of Operation + native call ID.
				// Resolve against durable execution receipts, including recovery.
				for _, operationID := range operationIDs {
					localDigest := sha256.Sum256([]byte(operationID + "\x00" + record.ToolCallID))
					if _, found := activityIDs["activity-"+hex.EncodeToString(localDigest[:16])]; found {
						hashed = true
						break
					}
				}
				if hashed || direct {
					identity.callIDs[record.ToolCallID] = struct{}{}
				}
			}
			if _, exact := identity.callIDs[record.ToolCallID]; exact && record.TurnID != "" {
				identity.turnIDs[record.TurnID] = struct{}{}
			}
		}
		if page.PreviousCursor == "" {
			return identity, nil
		}
		if _, duplicate := seen[page.PreviousCursor]; duplicate {
			return identity, nil
		}
		seen[page.PreviousCursor] = struct{}{}
		cursor = page.PreviousCursor
	}
}

func readMessageActivityRecords(
	ctx context.Context,
	historyReader messageActivityHistoryReader,
	target roomagent.RuntimeContextTarget,
	identity messageActivityIdentity,
) ([]roomagent.RuntimeHistoryRecord, bool, error) {
	records := make([]roomagent.RuntimeHistoryRecord, 0)
	cursor, seen := "", map[string]struct{}{}
	oldestLoaded := int(^uint(0) >> 1)
	oldestSelected := oldestLoaded
	for {
		limit := messageActivityPageLimit
		options := roomagent.RuntimeHistoryReadOptions{Limit: &limit}
		if cursor != "" {
			options.Cursor = &cursor
		}
		page, err := historyReader.ReadRuntimeHistory(ctx, target, options)
		if err != nil {
			return nil, false, err
		}
		if messageActivityStatus(page.Status) != httpapi.MessageActivityLogStatusAvailable {
			return nil, false, errors.New("Runtime history became unavailable")
		}
		for _, record := range page.Records {
			if record.Ordinal < oldestLoaded {
				oldestLoaded = record.Ordinal
			}
			if !messageActivityRecordMatches(record, identity.callIDs, identity.turnIDs) {
				continue
			}
			records = append(records, record)
			if record.Ordinal < oldestSelected {
				oldestSelected = record.Ordinal
			}
		}
		if len(records) > messageActivityRecordLimit {
			sort.Slice(records, func(i, j int) bool { return records[i].Ordinal < records[j].Ordinal })
			return records[len(records)-messageActivityRecordLimit:], true, nil
		}
		completeNativeTurn := len(identity.turnIDs) == 1 && len(records) > 0 && oldestLoaded < oldestSelected
		if completeNativeTurn || page.PreviousCursor == "" {
			break
		}
		if _, duplicate := seen[page.PreviousCursor]; duplicate {
			break
		}
		seen[page.PreviousCursor] = struct{}{}
		cursor = page.PreviousCursor
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Ordinal < records[j].Ordinal })
	return records, false, nil
}

func messageActivityRecordMatches(
	record roomagent.RuntimeHistoryRecord,
	callIDs map[string]struct{},
	turnIDs map[string]struct{},
) bool {
	if len(turnIDs) > 0 {
		_, exact := turnIDs[record.TurnID]
		return exact
	}
	_, exact := callIDs[record.ToolCallID]
	return exact
}

func messageActivityLogFromIdentity(
	identity messageActivityIdentity,
	records []roomagent.RuntimeHistoryRecord,
	truncated bool,
) httpapi.MessageActivityLog {
	model := httpapi.MessageActivityLog{
		Status: identity.status, ProviderKind: fallbackProviderKind(identity.providerKind),
		HasNativeTurn: len(identity.turnIDs) > 0, Truncated: truncated,
		Records: make([]httpapi.MessageActivityRecord, 0, len(records)),
	}
	if identity.reason != "" {
		model.Reason = stringPointer(identity.reason)
	}
	for _, record := range records {
		model.Records = append(model.Records, messageActivityRecordModel(record))
	}
	return model
}

func messageActivityRecordModel(record roomagent.RuntimeHistoryRecord) httpapi.MessageActivityRecord {
	item := httpapi.MessageActivityRecord{
		Ordinal: record.Ordinal, Timestamp: record.Timestamp,
		Category: httpapi.MessageActivityRecordCategory(record.Category), NativeType: record.NativeType,
		NativeRecord:   record.NativeRecord,
		RedactedFields: make([]httpapi.MessageActivityRedactedField, 0, len(record.RedactedFields)),
	}
	if record.TurnID != "" {
		item.TurnId = stringPointer(record.TurnID)
	}
	if record.ToolCallID != "" {
		item.ToolCallId = stringPointer(record.ToolCallID)
	}
	if record.ToolName != "" {
		item.ToolName = stringPointer(record.ToolName)
	}
	if record.Role != "" {
		item.Role = stringPointer(record.Role)
	}
	if record.Phase != "" {
		item.Phase = stringPointer(record.Phase)
	}
	for _, redacted := range record.RedactedFields {
		item.RedactedFields = append(item.RedactedFields, httpapi.MessageActivityRedactedField{
			Path: redacted.Path, Reason: httpapi.MessageActivityRedactedFieldReason(redacted.Reason), ByteCount: redacted.ByteCount,
		})
	}
	return item
}

func unavailableMessageActivityLog(reason string) httpapi.MessageActivityLog {
	return httpapi.MessageActivityLog{
		Status: httpapi.MessageActivityLogStatusUnavailable, ProviderKind: "unknown", Reason: stringPointer(reason),
		HasNativeTurn: false, Truncated: false,
		Records: []httpapi.MessageActivityRecord{},
	}
}

func messageActivityStatus(status string) httpapi.MessageActivityLogStatus {
	switch status {
	case "available":
		return httpapi.MessageActivityLogStatusAvailable
	case "unsupported":
		return httpapi.MessageActivityLogStatusUnsupported
	default:
		return httpapi.MessageActivityLogStatusUnavailable
	}
}

func fallbackProviderKind(value string) string {
	if value == "" {
		return "unknown"
	}
	return value
}

// runtimeContextTarget derives the Runtime identity from the canonical
// Context key and requires the stored identity columns to agree with it.
func runtimeContextTarget(row store.GetAgentExecutionContextRow) (roomagent.RuntimeContextTarget, error) {
	switch row.ContextKind {
	case "meta", "alter_ego", "document":
	default:
		return roomagent.RuntimeContextTarget{}, fmt.Errorf("unsupported Runtime Context kind %q", row.ContextKind)
	}
	decoded, err := agentruntimestate.DecodeContextKey(row.ContextKey)
	if err != nil || decoded.Kind != row.ContextKind || decoded.AgentID != row.AgentManagementID ||
		decoded.TaskID != row.TaskID.String || decoded.RoomID != row.RoomID.String ||
		decoded.DocumentID != row.DocumentID.String {
		return roomagent.RuntimeContextTarget{}, errors.New("Runtime Context identity is inconsistent")
	}
	return roomagent.RuntimeContextTarget{
		TenantID:   row.TenantID,
		ContextKey: row.ContextKey,
		Ref: roomagent.RuntimeContextRef{
			Kind: decoded.Kind, AgentID: decoded.AgentID, RoomID: decoded.RoomID, TaskID: decoded.TaskID,
			DocumentID: decoded.DocumentID,
		},
	}, nil
}

func stringPointer(value string) *string {
	return &value
}

// MessageActivityHistoryReader reads an Agent Runtime's native history.
type MessageActivityHistoryReader = messageActivityHistoryReader

// ErrMessageActivitiesUnavailable reports that the Agent Runtime history
// could not be read.
var ErrMessageActivitiesUnavailable = errors.New("message activities are unavailable")

// MessageActivities reads the sanitized Runtime records behind an Agent
// Message. history is nil when the Agent Service cannot read Runtime
// history. It reports pgx.ErrNoRows when the Message is not visible.
func (s *Service) MessageActivities(ctx context.Context, accountID, roomID, messageID string, history MessageActivityHistoryReader) (httpapi.MessageActivityLog, error) {
	message, err := s.queries.GetMessageForAccount(ctx, store.GetMessageForAccountParams{
		ID: messageID, RoomID: roomID, AccountID: textValue(accountID),
	})
	if err != nil {
		return httpapi.MessageActivityLog{}, err
	}
	if message.AuthorKind != "agent" {
		return unavailableMessageActivityLog("This Message has no linked Agent Runtime run"), nil
	}
	run, err := s.queries.GetAgentRunStatusForMessage(ctx, store.GetAgentRunStatusForMessageParams{
		MessageID: message.ID, RoomID: message.RoomID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return unavailableMessageActivityLog("The linked Agent Runtime run is no longer available"), nil
	}
	if err != nil {
		return httpapi.MessageActivityLog{}, internal("load Message activity run", err)
	}
	return s.runtimeActivityLog(ctx, runActivitySource{
		runID: run.RunID, contextKey: run.ContextKey, tenantID: run.TenantID, agentActorID: run.AgentActorID,
		task: run.TaskID.Valid, eventOrdinal: run.EventOrdinal,
	}, history)
}

// RunActivities reads the sanitized Runtime records of one Room Run.
// It reports pgx.ErrNoRows when the Run is not visible.
func (s *Service) RunActivities(ctx context.Context, accountID, roomID, runID string, history MessageActivityHistoryReader) (httpapi.MessageActivityLog, error) {
	run, err := s.queries.GetRoomRunStatusForAccount(ctx, store.GetRoomRunStatusForAccountParams{
		AccountID: accountID, RoomID: roomID, RunID: runID,
	})
	if err != nil {
		return httpapi.MessageActivityLog{}, err
	}
	return s.runtimeActivityLog(ctx, runActivitySource{
		runID: run.RunID, contextKey: run.ContextKey, tenantID: run.TenantID, agentActorID: run.AgentActorID,
		task: run.TaskID.Valid, eventOrdinal: run.EventOrdinal,
	}, history)
}

func (s *Service) runtimeActivityLog(ctx context.Context, run runActivitySource, historyReader MessageActivityHistoryReader) (httpapi.MessageActivityLog, error) {
	if run.task {
		return unavailableMessageActivityLog("Task activities are available through public Runtime presentation events"), nil
	}
	executionContext, err := s.queries.GetAgentExecutionContext(ctx, run.contextKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return unavailableMessageActivityLog("The linked Agent Runtime Context is no longer available"), nil
	}
	if err != nil {
		return httpapi.MessageActivityLog{}, internal("load Message activity Context", err)
	}
	if executionContext.TenantID != run.tenantID || executionContext.AgentActorID != run.agentActorID {
		return httpapi.MessageActivityLog{}, internal("validate Message activity Context", errors.New("Message and Runtime Context identity are inconsistent"))
	}
	target, err := runtimeContextTarget(executionContext)
	if err != nil {
		return httpapi.MessageActivityLog{}, internal("validate Message activity Context", err)
	}
	if historyReader == nil {
		return unavailableMessageActivityLog("Agent Runtime history is unavailable"), nil
	}
	activityIDs, activityTruncated, err := s.loadMessageActivityIDs(ctx, run.runID, run.eventOrdinal)
	if err != nil {
		return httpapi.MessageActivityLog{}, internal("load Message activity identities", err)
	}
	if len(activityIDs) == 0 {
		return unavailableMessageActivityLog("This Runtime run has no Activity identity for native History"), nil
	}
	operationIDs, err := s.queries.ListAgentRuntimeNativeOperationIDs(ctx, run.runID)
	if err != nil {
		return httpapi.MessageActivityLog{}, internal("load Message activity native operations", err)
	}
	identity, err := findMessageActivityIdentity(ctx, historyReader, target, activityIDs, operationIDs...)
	if err != nil {
		return httpapi.MessageActivityLog{}, ErrMessageActivitiesUnavailable
	}
	if identity.status != httpapi.MessageActivityLogStatusAvailable {
		return messageActivityLogFromIdentity(identity, nil, activityTruncated), nil
	}
	records, recordsTruncated, err := readMessageActivityRecords(ctx, historyReader, target, identity)
	if err != nil {
		return httpapi.MessageActivityLog{}, ErrMessageActivitiesUnavailable
	}
	model := messageActivityLogFromIdentity(identity, records, activityTruncated || recordsTruncated)
	if len(model.Records) == 0 && model.Reason == nil {
		model.Reason = stringPointer("No sanitized Runtime records were linked to this Message")
	}
	return model, nil
}
