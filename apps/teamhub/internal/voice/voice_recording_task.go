package voice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicecaptureqa"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

// ErrRecordingTaskAgentUnavailable reports a recording whose Agent is not available.
var ErrRecordingTaskAgentUnavailable = errors.New("recording task Agent is unavailable")

// recordingTask is one task request the recorder wrote in Ask for the
// recording's Agent. `respond` runs inside the sending transaction, records the
// sent Message, and builds the stored response.
type recordingTask struct {
	operation      string
	idempotencyKey string
	hash           []byte
	text           string
	// atMS is on the recording clock, which starts at the transcript start.
	atMS int64
	// throughMS bounds the attached transcript on the VoiceSession clock.
	throughMS int64
	commandID string
	// asks are the recorder's earlier Ask exchanges the request may refer to.
	asks    []voicecaptureqa.ContextAsk
	respond func(ctx context.Context, queries *store.Queries, messageID, documentID string) (any, error)
}

// sendRecordingTask sends one task from the recorder to the recording's
// direct Agent. The Message mentions the Agent, says what was asked, and
// attaches recording-context.md with the transcript up to the task, because
// the Agent did not hear the meeting.
func (s *Service) sendRecordingTask(ctx context.Context, accountID string, capture store.CaptureSession, task recordingTask) (idempotency.Result, error) {
	if replay, found, err := idempotency.Replay(ctx, s.pool, idempotency.AccountKey(accountID, task.operation, task.idempotencyKey), task.hash); err != nil || found {
		return replay, err
	}
	if !capture.TranscriptStartOffsetMs.Valid {
		return idempotency.Result{}, voicemedia.ErrCaptureConflict
	}
	markdown, err := s.recordingTaskContext(ctx, capture, task)
	if err != nil {
		return idempotency.Result{}, err
	}
	// A losing request must only clean up its own upload, so concurrent keys
	// must not share a removable object.
	object, err := s.artifacts.Put(ctx, bytes.NewReader([]byte(markdown)))
	if err != nil {
		return idempotency.Result{}, err
	}
	result, keepObject, err := s.sendRecordingTaskTx(ctx, accountID, capture, task, object)
	if !keepObject {
		if cleanupErr := artifactstore.DeleteDetached(ctx, s.artifacts, object.Key); cleanupErr != nil {
			err = errors.Join(err, cleanupErr)
		}
	}
	return result, err
}

// recordingTaskContext renders the accepted speech, recovered text included,
// all on the recording's clock.
func (s *Service) recordingTaskContext(ctx context.Context, capture store.CaptureSession, task recordingTask) (string, error) {
	origin := capture.TranscriptStartOffsetMs.Int64
	segments, err := s.queries.ListCaptureTranscriptSegments(ctx, store.ListCaptureTranscriptSegmentsParams{
		CaptureSessionID: capture.ID, StartOffsetMs: capture.RequestedTranscriptStartOffsetMs, EndOffsetMs: task.throughMS,
	})
	if err != nil {
		return "", err
	}
	transcript := make([]voicecaptureqa.ContextLine, 0, len(segments))
	for _, segment := range segments {
		if strings.TrimSpace(segment.Text) == "" {
			continue
		}
		transcript = append(transcript, voicecaptureqa.ContextLine{
			StartMS: segment.StartOffsetMs - origin, EndMS: segment.EndOffsetMs - origin,
			Speaker: segment.SpeakerID.String, Text: segment.Text,
		})
	}
	return voicecaptureqa.ContextMarkdown(voicecaptureqa.ContextInput{
		RecordedAt: capture.CreatedAt.Time, Text: task.text,
		AtMS: task.atMS, Asks: task.asks, Transcript: transcript,
	}), nil
}

func (s *Service) sendRecordingTaskTx(
	ctx context.Context,
	accountID string,
	capture store.CaptureSession,
	task recordingTask,
	object artifactstore.Object,
) (idempotency.Result, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return idempotency.Result{}, false, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if err = idempotency.Lock(ctx, tx, idempotency.AccountKey(accountID, task.operation, task.idempotencyKey)); err != nil {
		return idempotency.Result{}, false, err
	}
	if replay, found, err := idempotency.Replay(ctx, tx, idempotency.AccountKey(accountID, task.operation, task.idempotencyKey), task.hash); err != nil {
		return idempotency.Result{}, false, err
	} else if found {
		return replay, false, tx.Commit(ctx)
	}
	peer, err := queries.GetVoiceNotifyDirectPeerForAccountRoom(ctx, store.GetVoiceNotifyDirectPeerForAccountRoomParams{
		AccountID: accountID, RoomID: capture.RoomID,
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !peer.Active) {
		return idempotency.Result{}, false, ErrRecordingTaskAgentUnavailable
	}
	if err != nil {
		return idempotency.Result{}, false, err
	}
	// Canonical Message order: the mentioned member before any rooms row.
	if _, err = messagecreation.LockMessageMembers(ctx, queries, capture.RoomID, []string{peer.ID}); err != nil {
		return idempotency.Result{}, false, err
	}
	room, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: capture.RoomID, AccountID: textValue(accountID)})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	author, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: room.TenantID, AccountID: textValue(accountID)})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	if author.ID != capture.CreatedByActorID {
		return idempotency.Result{}, false, pgx.ErrNoRows
	}
	version, err := s.documents.CreateStoredRoomUploadTx(ctx, tx, document.StoredRoomUploadInput{
		AccountID: accountID, RoomID: room.ID, CommandID: task.commandID,
		Filename: "recording-context.md", RepresentationFormat: "markdown",
		MediaType: "text/markdown; charset=utf-8", Object: object, NativeDocument: true,
	})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{
		{Type: "reference", Content: "@" + peer.DisplayName, Target: peer.ID, TargetType: "agent"},
		{Type: "text", Content: " " + voicecaptureqa.RequestMessage(task.text, task.atMS) + "\n"},
		{Type: "document", Content: "recording-context.md", DocumentID: version.DocumentID, Presentation: "card"},
	})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	// A recording Ask hands off to the Meta without showing in the Room.
	message, err := messagecreation.Create(ctx, queries, messagecreation.Draft{
		TenantID: room.TenantID, RoomID: room.ID, Author: author, Content: content, Kind: "agent_runtime",
		AttachmentVersionIDs: []string{version.ID},
	})
	if err != nil {
		return idempotency.Result{}, false, err
	}
	response, err := task.respond(ctx, queries, message.Message.ID, version.DocumentID)
	if err != nil {
		return idempotency.Result{}, false, err
	}
	body, err := json.Marshal(response)
	if err != nil {
		return idempotency.Result{}, false, err
	}
	if err = idempotency.Save(ctx, tx, idempotency.AccountKey(accountID, task.operation, task.idempotencyKey), task.hash, idempotency.Record{
		ResourceID: message.Message.ID, Status: http.StatusOK, Body: body,
	}); err != nil {
		return idempotency.Result{}, false, err
	}
	// Once COMMIT is dispatched its error can mean an unknown result. Keep
	// the object in that case; a receipt retry resolves the business outcome.
	if err = tx.Commit(ctx); err != nil {
		return idempotency.Result{}, true, err
	}
	return idempotency.Result{Status: http.StatusOK, Body: body}, true, nil
}
