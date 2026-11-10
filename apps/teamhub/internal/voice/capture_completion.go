package voice

import (
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const captureCompletionIdempotencyKey = "capture-completion-v1"

const captureCompletionMessage = "I've organized the recording and transcript for you."

var errCaptureCompletionCommitOutcomeUnknown = errors.New("Capture completion commit outcome is unknown")

var errCaptureCompletionAgentUnavailable = errors.New("Capture Direct Room Agent is unavailable")

var errCaptureTranscriptIncomplete = errors.New("Capture transcript is incomplete")

func (s *Service) completeCaptureRecording(
	ctx context.Context,
	accountID, sessionID string,
	audioBody []byte,
) (idempotency.Result, error) {
	var audio httpapi.DocumentVersion
	if err := json.Unmarshal(audioBody, &audio); err != nil {
		return idempotency.Result{}, err
	}
	operation := "completeCaptureSession:" + sessionID
	requestHash := idempotency.HashRequest(struct {
		AudioVersionID string `json:"audio_version_id"`
	}{AudioVersionID: audio.Id})
	if replay, found, err := idempotency.Replay(
		ctx, s.pool, idempotency.AccountKey(accountID, operation, captureCompletionIdempotencyKey), requestHash,
	); err != nil || found {
		return replay, err
	}

	session, err := s.queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{
		ID: sessionID, AccountID: textValue(accountID),
	})
	if err != nil {
		return idempotency.Result{}, err
	}
	if session.Status != "finalized" || !session.DocumentVersionID.Valid || !session.DocumentID.Valid ||
		session.DocumentVersionID.String != audio.Id || session.DocumentID.String != audio.DocumentId {
		return idempotency.Result{}, errors.New("Capture completion audio authority is invalid")
	}
	audioVersion, err := s.documents.GetVersion(ctx, accountID, audio.Id)
	if err != nil {
		return idempotency.Result{}, err
	}
	if _, err := s.queries.GetFinalCaptureMediaOutput(ctx, sessionID); err != nil {
		return idempotency.Result{}, err
	}
	if !session.TranscriptStartOffsetMs.Valid || !session.TranscriptEndOffsetMs.Valid {
		return idempotency.Result{}, errCaptureTranscriptIncomplete
	}
	acceptedOffsetMS, err := s.queries.GetCaptureTranscriptAcceptedOffset(ctx, sessionID)
	if err != nil {
		return idempotency.Result{}, err
	}
	if acceptedOffsetMS < session.TranscriptEndOffsetMs.Int64 {
		return idempotency.Result{}, errCaptureTranscriptIncomplete
	}
	segments, err := s.queries.ListLiveKitCaptureCompletionSegments(ctx, sessionID)
	if err != nil {
		return idempotency.Result{}, err
	}
	// Clip the document projection; canonical ASR windows and task evidence stay unchanged.
	for index := range segments {
		segments[index].EndOffsetMs = min(segments[index].EndOffsetMs, session.TranscriptEndOffsetMs.Int64)
	}
	mediaRanges, err := s.queries.ListCaptureMediaRangesForCapture(ctx, sessionID)
	if err != nil {
		return idempotency.Result{}, err
	}
	gapRanges := captureGapExclusionRanges(mediaRanges)
	transcript := []byte(renderCaptureTranscriptFrom(
		segments,
		session.TranscriptStartOffsetMs.Int64,
		gapRanges,
		audioVersion.CreatedAt,
	))
	digest := sha256.Sum256(transcript)
	object, storageReplay, err := s.artifacts.PutIfAbsent(
		ctx, captureTranscriptObjectKey(sessionID), bytes.NewReader(transcript), int64(len(transcript)), digest,
	)
	if err != nil {
		return idempotency.Result{}, err
	}
	result, err := s.commitCaptureCompletion(
		ctx, accountID, operation, requestHash, session, audioVersion, object, audioBody,
	)
	if err != nil && !storageReplay && !errors.Is(err, errCaptureCompletionCommitOutcomeUnknown) {
		if cleanupErr := artifactstore.DeleteDetached(ctx, s.artifacts, object.Key); cleanupErr != nil {
			return idempotency.Result{}, errors.Join(err, cleanupErr)
		}
	}
	return result, err
}

func renderCaptureTranscriptFrom(
	segments []store.VoiceTranscriptSegment,
	baseOffsetMS int64,
	gapRanges []voicemedia.MediaTimeRange,
	generatedAt time.Time,
) string {
	var output strings.Builder
	output.WriteString(captureTranscriptHeading(generatedAt))
	normalizedGaps := captureTranscriptTimeRanges(gapRanges)
	if len(normalizedGaps) > 0 {
		gapDurationMS := int64(0)
		for _, current := range normalizedGaps {
			gapDurationMS += current.endMS - current.startMS
		}
		fmt.Fprintf(
			&output,
			"> This recording contains %d unrecoverable interruption(s), totaling %s of missing audio. Timestamps below are compressed to the available audio.\n\n",
			len(normalizedGaps),
			formatVoiceTranscriptDuration(gapDurationMS),
		)
	}
	headerLength := output.Len()
	for _, segment := range segments {
		text := strings.TrimSpace(segment.Text)
		if text != "" {
			startOffsetMS := segment.StartOffsetMs - baseOffsetMS
			endOffsetMS := segment.EndOffsetMs - baseOffsetMS
			if captureTranscriptRangeOverlaps(startOffsetMS, endOffsetMS, normalizedGaps) {
				output.WriteString("[Recognized during missing audio]")
			} else {
				output.WriteString(formatVoiceTranscriptRange(
					compactCaptureTranscriptOffset(startOffsetMS, normalizedGaps),
					compactCaptureTranscriptOffset(endOffsetMS, normalizedGaps),
				))
			}
			output.WriteString(" ")
			output.WriteString(captureTranscriptSpeechText(segment))
			output.WriteString("\n\n")
		}
	}
	if output.Len() == headerLength {
		output.WriteString("No speech was recognized.\n")
	}
	return strings.TrimRight(output.String(), "\n") + "\n"
}

// The first line names the recording and when its transcript was generated so
// a downloaded file is identifiable without the Room it came from.
func captureTranscriptHeading(generatedAt time.Time) string {
	if generatedAt.IsZero() {
		return "# Recording Transcript\n\n"
	}
	return "# Recording Transcript \u2014 " +
		generatedAt.UTC().Format("January 2, 2006 at 15:04") + " UTC\n\n"
}

type captureTranscriptTimeRange struct {
	startMS int64
	endMS   int64
}

func captureTranscriptTimeRanges(ranges []voicemedia.MediaTimeRange) []captureTranscriptTimeRange {
	result := make([]captureTranscriptTimeRange, 0, len(ranges))
	for _, current := range ranges {
		if current.EndMS <= current.StartMS {
			continue
		}
		result = append(result, captureTranscriptTimeRange{startMS: current.StartMS, endMS: current.EndMS})
	}
	slices.SortFunc(result, func(left, right captureTranscriptTimeRange) int {
		return cmp.Or(cmp.Compare(left.startMS, right.startMS), cmp.Compare(left.endMS, right.endMS))
	})
	merged := make([]captureTranscriptTimeRange, 0, len(result))
	for _, current := range result {
		if len(merged) == 0 || current.startMS > merged[len(merged)-1].endMS {
			merged = append(merged, current)
			continue
		}
		merged[len(merged)-1].endMS = max(merged[len(merged)-1].endMS, current.endMS)
	}
	return merged
}

func captureGapExclusionRanges(ranges []store.CaptureMediaRange) []voicemedia.MediaTimeRange {
	result := make([]voicemedia.MediaTimeRange, 0, len(ranges))
	for _, current := range ranges {
		if current.Kind == "gap" && current.EndOffsetMs > current.StartOffsetMs {
			result = append(result, voicemedia.MediaTimeRange{
				StartMS: current.StartOffsetMs,
				EndMS:   current.EndOffsetMs,
			})
		}
	}
	return result
}

func compactCaptureTranscriptOffset(offsetMS int64, excluded []captureTranscriptTimeRange) int64 {
	offsetMS = max(int64(0), offsetMS)
	removedMS := int64(0)
	for _, current := range excluded {
		if offsetMS >= current.endMS {
			removedMS += current.endMS - current.startMS
			continue
		}
		if offsetMS > current.startMS {
			removedMS += offsetMS - current.startMS
		}
		break
	}
	return offsetMS - removedMS
}

func captureTranscriptRangeOverlaps(
	startMS int64,
	endMS int64,
	ranges []captureTranscriptTimeRange,
) bool {
	for _, current := range ranges {
		if endMS <= current.startMS {
			return false
		}
		if startMS < current.endMS && endMS > current.startMS {
			return true
		}
	}
	return false
}

func formatVoiceTranscriptRange(startMS, endMS int64) string {
	return "[" + formatVoiceTranscriptOffset(startMS) + " - " + formatVoiceTranscriptOffset(endMS) + "]"
}

func formatVoiceTranscriptOffset(offsetMS int64) string {
	if offsetMS < 0 {
		offsetMS = 0
	}
	totalSeconds := offsetMS / 1000
	hours := totalSeconds / 3600
	minutes := totalSeconds % 3600 / 60
	seconds := totalSeconds % 60
	return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
}

func formatVoiceTranscriptDuration(durationMS int64) string {
	return formatVoiceTranscriptOffset((max(int64(0), durationMS) + 999) / 1_000 * 1_000)
}

func captureTranscriptSpeechText(segment store.VoiceTranscriptSegment) string {
	text := strings.TrimSpace(segment.Text)
	if label := voicetranscription.SpeakerLabel(segment.SpeakerID.String); segment.SpeakerID.Valid && label != "" {
		return label + " " + text
	}
	return text
}

func (s *Service) commitCaptureCompletion(
	ctx context.Context,
	accountID, operation string,
	requestHash []byte,
	session store.CaptureSession,
	audioVersion document.Version,
	object artifactstore.Object,
	audioBody []byte,
) (idempotency.Result, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return idempotency.Result{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	if err = idempotency.Lock(ctx, tx, idempotency.AccountKey(accountID, operation, captureCompletionIdempotencyKey)); err != nil {
		return idempotency.Result{}, err
	}
	if replay, found, replayErr := idempotency.Replay(
		ctx, tx, idempotency.AccountKey(accountID, operation, captureCompletionIdempotencyKey), requestHash,
	); replayErr != nil || found {
		if replayErr != nil {
			return idempotency.Result{}, replayErr
		}
		return replay, tx.Commit(ctx)
	}
	lockedSession, err := queries.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{
		ID: session.ID, AccountID: textValue(accountID),
	})
	if err != nil || lockedSession.Status != "finalized" || !lockedSession.DocumentVersionID.Valid ||
		lockedSession.DocumentVersionID.String != audioVersion.ID {
		return idempotency.Result{}, errors.Join(errors.New("Capture completion authority changed"), err)
	}
	version, err := s.documents.CreateStoredRoomUploadTx(ctx, tx, document.StoredRoomUploadInput{
		AccountID: accountID, RoomID: session.RoomID, CommandID: "capture-transcript:" + session.ID,
		Filename: "transcript.md", RepresentationFormat: "markdown",
		MediaType: "text/markdown; charset=utf-8", Object: object, NativeDocument: true,
	})
	if errors.Is(err, document.ErrNotFound) {
		return idempotency.Result{}, errCaptureCompletionAgentUnavailable
	}
	if err != nil {
		return idempotency.Result{}, err
	}
	if _, err = queries.AttachCaptureTranscriptDocument(ctx, store.AttachCaptureTranscriptDocumentParams{
		ID: session.ID, TranscriptDocumentID: textValue(version.DocumentID),
		TranscriptDocumentVersionID: textValue(version.ID),
	}); err != nil {
		return idempotency.Result{}, err
	}
	direct, directErr := queries.GetDirectRoom(ctx, session.RoomID)
	if directErr == nil {
		peer, peerErr := queries.GetVoiceNotifyDirectPeerForAccount(ctx, store.GetVoiceNotifyDirectPeerForAccountParams{
			AccountID: accountID, RoomID: session.RoomID, TargetAgentID: direct.AgentActorID,
		})
		if peerErr != nil || !peer.Active || (audioVersion.CreatedBy.Kind == "agent" && audioVersion.CreatedBy.ID != peer.ID) || (version.CreatedBy.Kind == "agent" && version.CreatedBy.ID != peer.ID) {
			return idempotency.Result{}, errors.Join(errCaptureCompletionAgentUnavailable, peerErr)
		}
		content, normalizeErr := messagecreation.Normalize([]messagecreation.Segment{
			{Type: "text", Content: captureCompletionMessage + "\n"},
			{Type: "document", Content: audioVersion.Filename, DocumentID: audioVersion.DocumentID, Presentation: "card"},
			{Type: "text", Content: "\n"},
			{Type: "document", Content: version.Filename, DocumentID: version.DocumentID, Presentation: "card"},
		})
		if normalizeErr != nil {
			return idempotency.Result{}, normalizeErr
		}
		_, messageErr := messagecreation.Create(ctx, queries, messagecreation.Draft{
			TenantID: session.TenantID, RoomID: session.RoomID, Content: content,
			Author: store.Actor{
				ID: peer.ID, TenantID: peer.TenantID, Kind: peer.Kind, DisplayName: peer.DisplayName,
				AccountID: peer.AccountID, Handle: peer.Handle, CreatedAt: peer.CreatedAt,
			},
			AttachmentVersionIDs: []string{audioVersion.ID, version.ID},
		})
		if messageErr != nil {
			return idempotency.Result{}, messageErr
		}
	} else if !errors.Is(directErr, pgx.ErrNoRows) {
		return idempotency.Result{}, directErr
	}
	if err = idempotency.Save(ctx, tx, idempotency.AccountKey(accountID, operation, captureCompletionIdempotencyKey), requestHash, idempotency.Record{ResourceID: version.ID, Status: http.StatusCreated, Body: audioBody}); err != nil {
		return idempotency.Result{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return idempotency.Result{}, errors.Join(errCaptureCompletionCommitOutcomeUnknown, err)
	}
	return idempotency.Result{Status: http.StatusCreated, Body: audioBody}, nil
}

func captureTranscriptObjectKey(sessionID string) string {
	digest := sha256.Sum256([]byte("capture-transcript:" + sessionID))
	return "object_" + hex.EncodeToString(digest[:16])
}
