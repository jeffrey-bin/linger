package taskexecution

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ParticipantMetaWake is the immutable correlation between one frozen Task
// participant, its private Meta Inbox wake, and the public Task messages that
// the alter ego must read for this turn.
type ParticipantMetaWake struct {
	ActorID          string           `json:"actor_id"`
	AuthorActorID    string           `json:"author_actor_id"`
	MetaSeq          int64            `json:"meta_seq"`
	PublicMessageIDs []string         `json:"public_message_ids"`
	Message          TurnMessageInput `json:"message"`
}

// SubmitTurnEffectPayload separates the shared Task Inbox context from the
// private Meta Inbox messages that are the exact trusted-turn ingress.
// Message remains populated for old persisted effects and cleanup replay.
type SubmitTurnEffectPayload struct {
	AttemptID            string                `json:"attempt_id"`
	InputRevision        int64                 `json:"input_revision"`
	RecipientActorIDs    []string              `json:"recipient_actor_ids"`
	InputManifest        json.RawMessage       `json:"input_manifest,omitempty"`
	PublicContextMessage *TurnMessageInput     `json:"public_context_message,omitempty"`
	RecipientWakes       []ParticipantMetaWake `json:"recipient_wakes,omitempty"`
	FeedbackMessageID    string                `json:"feedback_message_id,omitempty"`
	Message              TurnMessageInput      `json:"message"`
	Capability           string                `json:"capability,omitempty"`
	// Steer asks the Agent to put a Meta message into the AlterEgo's running
	// turn; when the turn cannot take it, the message runs as the next turn.
	Steer bool `json:"steer,omitempty"`
}

// AppendParticipantMetaWakes durably appends exactly one private wake to every
// recipient's frozen Meta Inbox. Callers must run it in the same transaction
// that creates the corresponding InputRevision and submit effect.
func AppendParticipantMetaWakes(
	ctx context.Context,
	queries *store.Queries,
	taskID, tenantID string,
	authorActorID string,
	recipientActorIDs []string,
	publicMessage TurnMessageInput,
) ([]ParticipantMetaWake, error) {
	authorActorID = strings.TrimSpace(authorActorID)
	if queries == nil || strings.TrimSpace(taskID) == "" || strings.TrimSpace(tenantID) == "" || authorActorID == "" {
		return nil, ErrInvalid
	}
	recipients, err := normalizedUniqueIDs(recipientActorIDs)
	if err != nil {
		return nil, err
	}
	publicMessage, err = normalizeTurnMessage(publicMessage)
	if err != nil {
		return nil, err
	}
	wakes := make([]ParticipantMetaWake, 0, len(recipients))
	for _, actorID := range recipients {
		if err := queries.EnsureTaskMetaInbox(ctx, store.EnsureTaskMetaInboxParams{
			TaskID: taskID, TenantID: tenantID, AgentActorID: actorID,
		}); err != nil {
			return nil, err
		}
		inbox, err := queries.GetTaskMetaInboxForUpdate(ctx, store.GetTaskMetaInboxForUpdateParams{
			TaskID: taskID, TenantID: tenantID, AgentActorID: actorID,
		})
		if err != nil {
			return nil, err
		}
		message := TurnMessageInput{
			MessageID: newID("task_meta_message_"), RawMessage: publicMessage.RawMessage,
			Segments: append(json.RawMessage(nil), publicMessage.Segments...), Author: publicMessage.Author,
		}
		nextSeq := inbox.ThroughSeq + 1
		if _, err := queries.CreateTaskMetaMessage(ctx, store.CreateTaskMetaMessageParams{
			ID: message.MessageID, TenantID: tenantID, TaskID: taskID,
			AgentActorID: actorID, MetaSeq: nextSeq, AuthorActorID: authorActorID,
			Body: message.RawMessage, Segments: message.Segments,
		}); err != nil {
			return nil, err
		}
		updated, err := queries.SetTaskMetaInboxThroughSeq(ctx, store.SetTaskMetaInboxThroughSeqParams{
			TaskID: taskID, TenantID: tenantID, AgentActorID: actorID, ThroughSeq: nextSeq,
		})
		if err != nil {
			return nil, err
		}
		if updated != 1 {
			return nil, ErrConflict
		}
		wakes = append(wakes, ParticipantMetaWake{
			ActorID: actorID, AuthorActorID: authorActorID, MetaSeq: nextSeq,
			PublicMessageIDs: []string{publicMessage.MessageID}, Message: message,
		})
	}
	return wakes, nil
}

// FreezeParticipantWakeManifest adds the complete public/private correlation
// to the immutable InputRevision manifest without replacing caller metadata.
func FreezeParticipantWakeManifest(
	raw json.RawMessage,
	publicMessage TurnMessageInput,
	wakes []ParticipantMetaWake,
) ([]byte, error) {
	manifestBytes, err := canonicalObject(raw)
	if err != nil {
		return nil, ErrInvalid
	}
	var manifest map[string]any
	if json.Unmarshal(manifestBytes, &manifest) != nil {
		return nil, ErrInvalid
	}
	message, err := normalizeTurnMessage(publicMessage)
	if err != nil || len(wakes) == 0 {
		return nil, ErrInvalid
	}
	publicMessageIDs := []string{message.MessageID}
	wakeAuthorActorID := wakes[0].AuthorActorID
	for _, wake := range wakes {
		if wake.ActorID == "" || wake.AuthorActorID == "" || wake.MetaSeq < 1 || wake.Message.MessageID == "" ||
			wake.AuthorActorID != wakeAuthorActorID || len(wake.PublicMessageIDs) != 1 || wake.PublicMessageIDs[0] != message.MessageID {
			return nil, ErrInvalid
		}
	}
	manifest["public_message_ids"] = publicMessageIDs
	manifest["public_context_message"] = message
	manifest["recipient_wakes"] = wakes
	manifest["wake_author_actor_id"] = wakeAuthorActorID
	encoded, _, err := canonicalHash(manifest)
	return encoded, err
}

func NewRoutedSubmitTurnEffectPayload(
	attemptID string,
	inputRevision int64,
	recipientActorIDs []string,
	inputManifest json.RawMessage,
	publicMessage TurnMessageInput,
	wakes []ParticipantMetaWake,
	capability string,
) (SubmitTurnEffectPayload, error) {
	recipients, err := normalizedUniqueIDs(recipientActorIDs)
	if err != nil || strings.TrimSpace(attemptID) == "" || inputRevision < 1 || strings.TrimSpace(capability) == "" {
		return SubmitTurnEffectPayload{}, ErrInvalid
	}
	message, err := normalizeTurnMessage(publicMessage)
	if err != nil || len(wakes) != len(recipients) {
		return SubmitTurnEffectPayload{}, ErrInvalid
	}
	byActor := make(map[string]ParticipantMetaWake, len(wakes))
	for _, wake := range wakes {
		byActor[wake.ActorID] = wake
	}
	orderedWakes := make([]ParticipantMetaWake, 0, len(recipients))
	for _, actorID := range recipients {
		wake, found := byActor[actorID]
		if !found || wake.AuthorActorID == "" || len(wake.PublicMessageIDs) != 1 || wake.PublicMessageIDs[0] != message.MessageID {
			return SubmitTurnEffectPayload{}, ErrInvalid
		}
		orderedWakes = append(orderedWakes, wake)
	}
	return SubmitTurnEffectPayload{
		AttemptID: attemptID, InputRevision: inputRevision,
		RecipientActorIDs: recipients, InputManifest: inputManifest,
		PublicContextMessage: &message, RecipientWakes: orderedWakes,
		Message: message, Capability: capability,
	}, nil
}

func normalizedUniqueIDs(values []string) ([]string, error) {
	if len(values) == 0 || len(values) > maxParticipantLen {
		return nil, ErrInvalid
	}
	result := append([]string(nil), values...)
	for index := range result {
		result[index] = strings.TrimSpace(result[index])
		if result[index] == "" {
			return nil, ErrInvalid
		}
	}
	sort.Strings(result)
	for index := 1; index < len(result); index++ {
		if result[index] == result[index-1] {
			return nil, ErrInvalid
		}
	}
	return result, nil
}
