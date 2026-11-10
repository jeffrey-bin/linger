package agentruntimestate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	roomInboxPattern     = regexp.MustCompile(`^room:([A-Za-z0-9][A-Za-z0-9_-]{0,63})$`)
	threadInboxPattern   = regexp.MustCompile(`^thread:([A-Za-z0-9][A-Za-z0-9_-]{0,63})$`)
	taskInboxPattern     = regexp.MustCompile(`^task:([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$`)
	taskMetaInboxPattern = regexp.MustCompile(`^taskmeta:([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$`)
	metaInboxPattern     = regexp.MustCompile(`^meta:`)
	activityIDPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	commandIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$`)
)

// OpenRuntimeStatus makes the Room its sources resolve to show a running
// Run's status.
func (s *Service) OpenRuntimeStatus(ctx context.Context, input OpenStatusInput) (OpenStatusResult, error) {
	if strings.TrimSpace(input.LocalRunID) == "" || len(input.InitialSourceIDs) > 1024 {
		return OpenStatusResult{}, ErrInvalid
	}
	if hasDuplicateOrBlank(input.InitialSourceIDs) {
		return OpenStatusResult{}, ErrInvalid
	}
	return executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (OpenStatusResult, error) {
		inputs, err := queries.ListAgentLocalRunInputs(ctx, input.LocalRunID)
		if err != nil {
			return OpenStatusResult{}, err
		}
		provenance, err := runtimeStatusProvenance(inputs)
		if err != nil || (input.InitialSourceIDs != nil && !sameStringSet(input.InitialSourceIDs, provenance.SourceInboxIDs)) {
			return OpenStatusResult{}, ErrConflict
		}
		contextRow, authority, err := lockInboxContext(ctx, queries, input.ContextKey, provenance.SourceInboxIDs, false)
		if err != nil {
			return OpenStatusResult{}, err
		}
		run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{
			ContextKey: input.ContextKey, RunID: input.LocalRunID,
		})
		if isNoRows(err) {
			return OpenStatusResult{}, ErrNotFound
		}
		if err != nil {
			return OpenStatusResult{}, err
		}
		if run.Status != "running" || run.Epoch.String != input.Epoch {
			return OpenStatusResult{}, ErrConflict
		}
		log, err := openRunStatus(ctx, queries, contextRow, input.LocalRunID, authority.memberRooms)
		if err != nil || log == nil {
			return OpenStatusResult{}, err
		}
		if err := log.publish(ctx, queries); err != nil {
			return OpenStatusResult{}, err
		}
		return OpenStatusResult{Opened: true, RoomID: log.run.StatusRoomID}, nil
	})
}

// openRunStatus resolves the Room that shows a Run's status from its initial
// sources and records it on the Run. Nil means no Room may show it.
func openRunStatus(ctx context.Context, queries *store.Queries, contextRow contextRecord, runID string, memberRooms map[string]bool) (*runStatusLog, error) {
	inputs, err := queries.ListAgentLocalRunInputs(ctx, runID)
	if err != nil {
		return nil, err
	}
	provenance, err := runtimeStatusProvenance(inputs)
	if err != nil {
		return nil, err
	}
	roomID, memberRoomID, publishable, err := resolveRuntimeStatusRoom(ctx, queries, contextRow, provenance.SourceInboxIDs)
	if err != nil || !publishable {
		return nil, err
	}
	// Reception can be authorized without Work Room membership. A member added
	// after the prelock is not a reason to acquire a new row lock while holding
	// Context authority: leave takes those same locks in the opposite order.
	if !memberRooms[memberRoomID] {
		return nil, nil
	}
	if contextRow.RoomID.Valid && contextRow.RoomID.String != memberRoomID {
		return nil, ErrFenced
	}
	authority, err := queries.GetRoomAgentMessageAuthority(ctx, store.GetRoomAgentMessageAuthorityParams{
		RoomID: roomID, AgentManagementID: contextRow.AgentManagementID,
	})
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if authority.TenantID != contextRow.TenantID || authority.AgentID != contextRow.AgentActorID {
		return nil, ErrConflict
	}
	return showRunStatus(ctx, queries, runID, roomID)
}

func projectQueuedRun(ctx context.Context, queries *store.Queries, contextKey, runID string, memberRooms map[string]bool) error {
	contextRow, err := queries.GetAgentExecutionContext(ctx, contextKey)
	if err != nil {
		return err
	}
	log, err := openRunStatus(ctx, queries, contextRow, runID, memberRooms)
	if errors.Is(err, ErrFenced) || errors.Is(err, ErrConflict) || errors.Is(err, ErrInvalid) {
		// The queued status is a best-effort public indicator. A Run whose
		// sources do not resolve to a publishable Room for this Context (for
		// example a coordinator accepting Task input from another work Room)
		// still enqueues; it simply has no queued status to show.
		return nil
	}
	if err != nil || log == nil || log.stopped() {
		return err
	}
	if _, err := log.append(ctx, queries, store.InsertAgentRuntimePresentationEventParams{
		CommandID: "queued-status:" + runID, EventType: "status.changed",
		Payload: json.RawMessage(`{"type":"status.changed","status":"queued"}`),
	}); err != nil {
		return err
	}
	return log.publish(ctx, queries)
}

// OfferRuntimePresentationEvents appends one ordered batch of a running Run's
// events and announces the new sequence. The event log is the command
// receipt: an event whose command already has an event returns that event's
// ordinal, or conflicts when the stored event differs.
func (s *Service) OfferRuntimePresentationEvents(ctx context.Context, input OfferPresentationEventsInput) (OfferPresentationEventResult, error) {
	if strings.TrimSpace(input.LocalRunID) == "" || len(input.Events) == 0 || len(input.Events) > 100 {
		return OfferPresentationEventResult{}, ErrInvalid
	}
	events := make([]normalizedPresentationEvent, 0, len(input.Events))
	for _, offered := range input.Events {
		event, err := normalizeOfferedPresentationEvent(offered.Event)
		if err != nil || !commandIDPattern.MatchString(offered.CommandID) {
			return OfferPresentationEventResult{}, ErrInvalid
		}
		events = append(events, event)
	}
	if s == nil || s.pool == nil {
		return OfferPresentationEventResult{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OfferPresentationEventResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	log, err := openRunStatusLog(ctx, queries, input.LocalRunID)
	if err != nil {
		return OfferPresentationEventResult{}, err
	}
	if log == nil {
		return OfferPresentationEventResult{}, ErrNotFound
	}
	var last int64
	appended := false
	for index, event := range events {
		commandID := input.Events[index].CommandID
		if log.taskRun() {
			event, err = taskPublicPresentationEvent(event)
			if err != nil {
				return OfferPresentationEventResult{}, err
			}
		}
		accepted, err := queries.GetAgentRuntimePresentationEventByCommand(ctx, commandID)
		if err == nil {
			if accepted.LocalRunID != input.LocalRunID || accepted.EventType != event.EventType || !sameJSON(accepted.Payload, event.Payload) {
				return OfferPresentationEventResult{}, ErrIdempotencyConflict
			}
			last = accepted.EventOrdinal
			continue
		}
		if !isNoRows(err) {
			return OfferPresentationEventResult{}, err
		}
		if log.stopped() {
			return OfferPresentationEventResult{}, ErrConflict
		}
		if err := validatePresentationActivityLifecycle(ctx, queries, input.LocalRunID, event); err != nil {
			return OfferPresentationEventResult{}, err
		}
		inserted, err := log.append(ctx, queries, store.InsertAgentRuntimePresentationEventParams{
			CommandID: commandID, EventType: event.EventType, Payload: event.Payload,
			Outcome: optionalText(event.Outcome), ActivityID: optionalText(event.ActivityID),
		})
		if err != nil {
			return OfferPresentationEventResult{}, err
		}
		last, appended = inserted.EventOrdinal, true
	}
	if appended {
		if err := log.publish(ctx, queries); err != nil {
			return OfferPresentationEventResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return OfferPresentationEventResult{}, err
	}
	return OfferPresentationEventResult{Accepted: true, EventOrdinal: last}, nil
}

type statusProvenance struct {
	SourceInboxIDs []string
}

func runtimeStatusProvenance(rows []store.ListAgentLocalRunInputsRow) (statusProvenance, error) {
	result := statusProvenance{}
	sources := map[string]struct{}{}
	for _, row := range rows {
		if row.RunRelation != "initial" {
			continue
		}
		var payload struct {
			SourceInboxIDs []string `json:"sourceInboxIds"`
		}
		if json.Unmarshal(row.Payload, &payload) != nil {
			return statusProvenance{}, ErrConflict
		}
		for _, inboxID := range payload.SourceInboxIDs {
			if strings.TrimSpace(inboxID) == "" {
				return statusProvenance{}, ErrConflict
			}
			if _, exists := sources[inboxID]; !exists {
				sources[inboxID] = struct{}{}
				result.SourceInboxIDs = append(result.SourceInboxIDs, inboxID)
			}
		}
	}
	return result, nil
}

// resolveRuntimeStatusRoom returns the Room that shows a Run's status and the
// Room whose membership authorizes it. Sources from one Thread show in that
// Thread under its parent's membership; sources from a Room and its Threads,
// or from several of its Threads, show in the Room. Sources from different
// Rooms do not publish.
func resolveRuntimeStatusRoom(
	ctx context.Context,
	queries *store.Queries,
	contextRow contextRecord,
	sourceInboxIDs []string,
) (string, string, bool, error) {
	if len(sourceInboxIDs) == 0 {
		return "", "", false, nil
	}
	if contextRow.ContextKind == "alter_ego" && len(sourceInboxIDs) == 1 && metaInboxPattern.MatchString(sourceInboxIDs[0]) {
		roomID, publishable, err := resolveTaskRuntimeStatusRoom(ctx, queries, contextRow, sourceInboxIDs)
		return roomID, roomID, publishable, err
	}
	roomID, memberRoomID := "", ""
	for _, inboxID := range sourceInboxIDs {
		var shown, member string
		if matches := roomInboxPattern.FindStringSubmatch(inboxID); matches != nil {
			shown, member = matches[1], matches[1]
		} else if matches := threadInboxPattern.FindStringSubmatch(inboxID); matches != nil {
			value, err := queries.GetAgentRuntimeThreadInboxParentRoom(ctx, store.GetAgentRuntimeThreadInboxParentRoomParams{
				ThreadID: matches[1], TenantID: contextRow.TenantID, AgentActorID: contextRow.AgentActorID,
			})
			if isNoRows(err) {
				return "", "", false, nil
			}
			if err != nil {
				return "", "", false, err
			}
			shown, member = matches[1], value
		} else if matches := taskInboxPattern.FindStringSubmatch(inboxID); matches != nil {
			value, err := queries.GetAgentRuntimeTaskInboxRoom(ctx, store.GetAgentRuntimeTaskInboxRoomParams{
				TaskID: matches[1], TenantID: contextRow.TenantID, AgentActorID: contextRow.AgentActorID,
			})
			if isNoRows(err) {
				return "", "", false, nil
			}
			if err != nil {
				return "", "", false, err
			}
			shown, member = value, value
		} else if metaInboxPattern.MatchString(inboxID) {
			return "", "", false, nil
		} else if taskMetaInboxPattern.MatchString(inboxID) {
			return "", "", false, nil
		} else {
			return "", "", false, ErrInvalid
		}
		switch {
		case memberRoomID == "":
			roomID, memberRoomID = shown, member
		case memberRoomID != member:
			return "", "", false, nil
		case roomID != shown:
			roomID = memberRoomID
		}
	}
	return roomID, memberRoomID, true, nil
}

type normalizedPresentationEvent struct {
	EventType  string
	Payload    json.RawMessage
	Outcome    string
	ActivityID string
}

type workingStatusEvent struct {
	Type   string  `json:"type"`
	Status string  `json:"status"`
	Title  *string `json:"title,omitempty"`
}

type stoppedStatusEvent struct {
	UnconfirmedInputIDs []string              `json:"unconfirmed_input_ids,omitempty"`
	Type                string                `json:"type"`
	Status              string                `json:"status"`
	Outcome             string                `json:"outcome"`
	Failure             *PublicRuntimeFailure `json:"failure,omitempty"`
}

type planUpdatedEvent struct {
	Type        string     `json:"type"`
	Explanation *string    `json:"explanation,omitempty"`
	Steps       []planStep `json:"steps"`
}

type planStep struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

type activityStartedEvent struct {
	Type       string                 `json:"type"`
	ActivityID string                 `json:"activity_id"`
	Kind       string                 `json:"kind"`
	Title      string                 `json:"title"`
	Content    []activityContentBlock `json:"content,omitempty"`
}

type activityUpdatedEvent struct {
	Type       string `json:"type"`
	ActivityID string `json:"activity_id"`
	Detail     string `json:"detail"`
}

type activityFinishedEvent struct {
	Type       string                 `json:"type"`
	ActivityID string                 `json:"activity_id"`
	Outcome    string                 `json:"outcome"`
	Content    []activityContentBlock `json:"content,omitempty"`
}

type activityContentBlock struct {
	Format  string  `json:"format"`
	Label   *string `json:"label,omitempty"`
	Content string  `json:"content"`
}

func normalizeOfferedPresentationEvent(raw json.RawMessage) (normalizedPresentationEvent, error) {
	if len(raw) == 0 || len(raw) > 200000 {
		return normalizedPresentationEvent{}, ErrInvalid
	}
	var discriminator struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &discriminator) != nil {
		return normalizedPresentationEvent{}, ErrInvalid
	}
	switch discriminator.Type {
	case "status.changed":
		var event workingStatusEvent
		if strictJSON(raw, &event) != nil || event.Type != "status.changed" || event.Status != "queued" && event.Status != "working" && event.Status != "thinking" ||
			event.Title != nil && ((event.Status != "thinking" && event.Status != "queued") || strings.TrimSpace(*event.Title) == "" || len([]rune(*event.Title)) > 50000) {
			return normalizedPresentationEvent{}, ErrInvalid
		}
		return normalizedEvent(event.Type, event)
	case "plan.updated":
		var event planUpdatedEvent
		if strictJSON(raw, &event) != nil || event.Type != "plan.updated" || event.Steps == nil || len(event.Steps) > 1000 {
			return normalizedPresentationEvent{}, ErrInvalid
		}
		if event.Explanation != nil && len([]rune(*event.Explanation)) > 50000 {
			return normalizedPresentationEvent{}, ErrInvalid
		}
		for _, step := range event.Steps {
			if len([]rune(step.Content)) > 50000 || step.Status != "pending" && step.Status != "in_progress" && step.Status != "completed" && step.Status != "canceled" {
				return normalizedPresentationEvent{}, ErrInvalid
			}
		}
		return normalizedEvent(event.Type, event)
	case "activity.started":
		var event activityStartedEvent
		if strictJSON(raw, &event) != nil || event.Type != "activity.started" ||
			!activityIDPattern.MatchString(event.ActivityID) || !validActivityKind(event.Kind) ||
			strings.TrimSpace(event.Title) == "" || len([]rune(event.Title)) > 200 || !validActivityContent(event.Content) {
			return normalizedPresentationEvent{}, ErrInvalid
		}
		normalized, err := normalizedEvent(event.Type, event)
		normalized.ActivityID = event.ActivityID
		return normalized, err
	case "activity.updated":
		var event activityUpdatedEvent
		if strictJSON(raw, &event) != nil || event.Type != "activity.updated" ||
			!activityIDPattern.MatchString(event.ActivityID) || strings.TrimSpace(event.Detail) == "" || len([]rune(event.Detail)) > 200 {
			return normalizedPresentationEvent{}, ErrInvalid
		}
		normalized, err := normalizedEvent(event.Type, event)
		normalized.ActivityID = event.ActivityID
		return normalized, err
	case "activity.finished":
		var event activityFinishedEvent
		if strictJSON(raw, &event) != nil || event.Type != "activity.finished" ||
			!activityIDPattern.MatchString(event.ActivityID) || !validActivityOutcome(event.Outcome) || !validActivityContent(event.Content) {
			return normalizedPresentationEvent{}, ErrInvalid
		}
		normalized, err := normalizedEvent(event.Type, event)
		normalized.ActivityID, normalized.Outcome = event.ActivityID, event.Outcome
		return normalized, err
	default:
		return normalizedPresentationEvent{}, ErrInvalid
	}
}

func validActivityKind(value string) bool {
	switch value {
	case "command", "tool", "file_change", "search", "read", "browse", "message", "message_read", "image", "delegation", "response", "interaction", "recovery", "review":
		return true
	default:
		return false
	}
}

func validActivityOutcome(value string) bool {
	return value == "succeeded" || value == "failed" || value == "canceled" || value == "declined"
}

func validActivityContent(blocks []activityContentBlock) bool {
	if len(blocks) > 6 {
		return false
	}
	for _, block := range blocks {
		if block.Format != "text" && block.Format != "code" && block.Format != "json" ||
			strings.TrimSpace(block.Content) == "" || len([]rune(block.Content)) > 4000 ||
			block.Label != nil && (strings.TrimSpace(*block.Label) == "" || len([]rune(*block.Label)) > 80) {
			return false
		}
	}
	return true
}

func validatePresentationActivityLifecycle(
	ctx context.Context,
	queries *store.Queries,
	localRunID string,
	event normalizedPresentationEvent,
) error {
	if event.ActivityID == "" {
		return nil
	}
	latest, err := queries.GetLatestAgentRuntimeActivityEvent(ctx, store.GetLatestAgentRuntimeActivityEventParams{
		LocalRunID: localRunID, ActivityID: event.ActivityID,
	})
	if event.EventType == "activity.started" {
		if isNoRows(err) {
			return nil
		}
		if err != nil {
			return err
		}
		return ErrConflict
	}
	if isNoRows(err) || latest.EventType == "activity.finished" {
		return ErrConflict
	}
	return err
}

func normalizedEvent(eventType string, value any) (normalizedPresentationEvent, error) {
	payload, err := canonicalJSON(value)
	if err != nil || len(payload) > 200000 {
		return normalizedPresentationEvent{}, ErrInvalid
	}
	return normalizedPresentationEvent{EventType: eventType, Payload: payload}, nil
}

func strictJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	return nil
}

// appendStoppedEvent ends a stopped Run's log with its stopped event.
func appendStoppedEvent(ctx context.Context, queries *store.Queries, log *runStatusLog, intent string, failure *PublicRuntimeFailure) error {
	outcome := "failed"
	if intent == "complete" {
		outcome = "completed"
	} else if intent == "canceled" {
		outcome = "canceled"
	}
	unconfirmed, err := queries.ListUnconfirmedAgentRuntimeRunInputs(ctx, log.run.RunID)
	if err != nil {
		return err
	}
	event := stoppedStatusEvent{Type: "status.changed", Status: "stopped", Outcome: outcome, Failure: failure, UnconfirmedInputIDs: unconfirmed}
	if log.taskRun() {
		event.UnconfirmedInputIDs = nil
	}
	payload, err := canonicalJSON(event)
	if err != nil {
		return err
	}
	_, err = log.append(ctx, queries, store.InsertAgentRuntimePresentationEventParams{
		CommandID: "stopped:" + log.run.RunID, EventType: event.Type, Payload: payload, Outcome: optionalText(""),
	})
	return err
}

func hasDuplicateOrBlank(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return true
		}
		if _, duplicate := seen[value]; duplicate {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}

func sameStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	leftCopy := append([]string(nil), left...)
	rightCopy := append([]string(nil), right...)
	sort.Strings(leftCopy)
	sort.Strings(rightCopy)
	for index := range leftCopy {
		if leftCopy[index] != rightCopy[index] {
			return false
		}
	}
	return true
}
