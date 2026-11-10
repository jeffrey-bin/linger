// The source Meta callback stream for managed Tasks is deliberately separate
// from the participant Meta wake stream: callbacks are addressed to the frozen
// Task coordinator, not to a Task Agent.

package taskexecution

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Errors returned by AppendMetaCallback.
var (
	ErrMetaCallbackInvalid     = errors.New("Task Meta callback input is invalid")
	ErrMetaCallbackUnavailable = errors.New("Task Meta callback stream is unavailable")
)

// MetaCallbackAppendInput is one callback to append.
type MetaCallbackAppendInput struct {
	TaskID        string
	TenantID      string
	Generation    int64
	AuthorActorID string
	Body          string
	Segments      []byte
	NonActionable bool
}

// MetaCallbackMessage is one persisted callback.
type MetaCallbackMessage struct {
	ID      string
	MetaSeq int64
}

// AppendMetaCallback persists one callback and advances the callback cursor in
// the same transaction. Callers must already have authenticated the frozen
// coordinator or the Task Agent actor that is allowed to write the callback.
func AppendMetaCallback(ctx context.Context, queries *store.Queries, input MetaCallbackAppendInput) (MetaCallbackMessage, error) {
	if queries == nil || strings.TrimSpace(input.TaskID) == "" ||
		strings.TrimSpace(input.TenantID) == "" || input.Generation < 1 ||
		strings.TrimSpace(input.AuthorActorID) == "" || strings.TrimSpace(input.Body) == "" ||
		len(input.Segments) == 0 {
		return MetaCallbackMessage{}, ErrMetaCallbackInvalid
	}
	callback, err := queries.GetTaskMetaCallbackForUpdate(ctx, store.GetTaskMetaCallbackForUpdateParams{
		TaskID: input.TaskID, TenantID: input.TenantID,
	})
	if err != nil {
		return MetaCallbackMessage{}, err
	}
	if callback.Generation != input.Generation {
		return MetaCallbackMessage{}, ErrMetaCallbackUnavailable
	}
	messageID, err := newMessageID()
	if err != nil {
		return MetaCallbackMessage{}, err
	}
	nextSeq := callback.ThroughSeq + 1
	if _, err := queries.CreateTaskMetaCallbackMessage(ctx, store.CreateTaskMetaCallbackMessageParams{
		ID: messageID, TaskID: input.TaskID, TenantID: input.TenantID,
		Generation: input.Generation, MetaSeq: nextSeq, AuthorActorID: input.AuthorActorID,
		Body: input.Body, Segments: input.Segments, NonActionable: input.NonActionable,
	}); err != nil {
		return MetaCallbackMessage{}, err
	}
	updated, err := queries.SetTaskMetaCallbackThroughSeq(ctx, store.SetTaskMetaCallbackThroughSeqParams{
		TaskID: input.TaskID, TenantID: input.TenantID, ThroughSeq: nextSeq,
	})
	if err != nil {
		return MetaCallbackMessage{}, err
	}
	if updated != 1 {
		return MetaCallbackMessage{}, ErrMetaCallbackUnavailable
	}
	if err := queries.NotifyVoiceLiveTaskChanged(ctx, input.TaskID); err != nil {
		return MetaCallbackMessage{}, err
	}
	return MetaCallbackMessage{ID: messageID, MetaSeq: nextSeq}, nil
}

func newMessageID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "task_meta_callback_" + hex.EncodeToString(bytes), nil
}
