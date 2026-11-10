package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func TestLiveKitCaptureCompletionStopsWhenDocumentIsGone(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t, nil, starting(app.JobQueue))
	q := store.New(env.pool)
	captureID, documentID, roomID := seedFinalizedLiveKitCapture(t, env, alice, "gone", "account_alice")
	if _, err := env.pool.Exec(t.Context(), "UPDATE documents SET status='trashed',trashed_at=GREATEST(updated_at,clock_timestamp()),updated_at=GREATEST(updated_at,clock_timestamp()) WHERE id=$1 AND status='active'", documentID); err != nil {
		t.Fatal(err)
	}
	queueVoiceJob(t, env.pool, voicemedia.CaptureCompletionArgs{CaptureSessionID: captureID})
	deadline := time.Now().Add(30 * time.Second)
	var capture store.CaptureSession
	var err error
	for {
		capture, err = q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: captureID, AccountID: pgtype.Text{String: "account_alice", Valid: true}})
		if err != nil {
			t.Fatal(err)
		}
		if capture.VoiceCompletionFailedAt.Valid {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("missing Document kept the completion retryable")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if capture.VoiceCompletionFailureCode.String != "document_not_found" || capture.TranscriptDocumentVersionID.Valid {
		t.Fatalf("terminal completion=%+v", capture)
	}
	if pendingLiveKitCapture(t, q, captureID) {
		t.Fatal("terminal completion was selected again")
	}
	if _, err = q.GetActiveLiveKitCaptureForVoiceSession(t.Context(), pgtype.Text{String: "voice_completion_gone", Valid: true}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("terminal completion still counted as active Capture: %v", err)
	}
	if _, err = q.GetActiveLiveKitCaptureForAccountRoom(t.Context(), store.GetActiveLiveKitCaptureForAccountRoomParams{AccountID: "account_alice", RoomID: roomID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("terminal completion still counted as the Room's active Capture: %v", err)
	}
}

func TestLiveKitCaptureCompletionRetryLimitBecomesTerminal(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil, skipping(app.VoiceJobs))
	q := store.New(env.pool)
	captureID, _, _ := seedFinalizedLiveKitCapture(t, env, alice, "limit", "account_alice")
	first, err := q.RetryLiveKitCaptureCompletion(t.Context(), store.RetryLiveKitCaptureCompletionParams{
		ID: captureID, MaxAttempts: 3, FailureCode: "retry_exhausted",
	})
	if err != nil || first.VoiceCompletionAttempts != 1 || first.VoiceCompletionFailedAt.Valid {
		t.Fatalf("first retry=%+v err=%v", first, err)
	}
	if !pendingLiveKitCapture(t, q, captureID) {
		t.Fatal("retryable completion was not selected")
	}
	for attempt := int32(2); attempt <= 3; attempt++ {
		retried, retryErr := q.RetryLiveKitCaptureCompletion(t.Context(), store.RetryLiveKitCaptureCompletionParams{
			ID: captureID, MaxAttempts: 3, FailureCode: "retry_exhausted",
		})
		if retryErr != nil || retried.VoiceCompletionAttempts != attempt {
			t.Fatalf("attempt %d=%+v err=%v", attempt, retried, retryErr)
		}
		if attempt < 3 && retried.VoiceCompletionFailedAt.Valid {
			t.Fatal("retry budget exhausted early")
		}
		if attempt == 3 && (!retried.VoiceCompletionFailedAt.Valid || retried.VoiceCompletionFailureCode.String != "retry_exhausted") {
			t.Fatalf("exhausted retry=%+v", retried)
		}
	}
	if pendingLiveKitCapture(t, q, captureID) {
		t.Fatal("exhausted completion was selected again")
	}
	if _, err = q.RetryLiveKitCaptureCompletion(t.Context(), store.RetryLiveKitCaptureCompletionParams{
		ID: captureID, MaxAttempts: 3, FailureCode: "retry_exhausted",
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("exhausted retry err=%v", err)
	}
}

func TestLiveKitCaptureCompletionWorkerRetryBudget(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, nil, skipping(app.VoiceJobs))
	if env.application == nil {
		t.Fatal("voice env did not retain App")
	}
	q := store.New(env.pool)
	captureID, _, roomID := seedFinalizedLiveKitCapture(t, env, alice, "budget", "account_alice")
	stopped, stop := context.WithCancel(t.Context())
	stop()
	if delay, err := env.application.SettleLiveKitCaptureCompletionForTest(stopped, captureID, 0, context.Canceled); !errors.Is(err, context.Canceled) || delay != 5*time.Second {
		t.Fatalf("canceled settle delay=%v err=%v", delay, err)
	}
	capture := liveKitCaptureForTest(t, q, captureID)
	if capture.VoiceCompletionAttempts != 0 || capture.VoiceCompletionFailedAt.Valid {
		t.Fatalf("canceled counted as a retry: %+v", capture)
	}
	if delay, err := env.application.SettleLiveKitCaptureCompletionForTest(t.Context(), captureID, 0, context.DeadlineExceeded); !errors.Is(err, context.DeadlineExceeded) || delay != 5*time.Second {
		t.Fatalf("downstream deadline settle delay=%v err=%v", delay, err)
	}
	capture = liveKitCaptureForTest(t, q, captureID)
	if capture.VoiceCompletionAttempts != 1 || capture.VoiceCompletionFailedAt.Valid {
		t.Fatalf("downstream deadline did not count a retry: %+v", capture)
	}
	if _, err := env.pool.Exec(t.Context(), "UPDATE capture_sessions SET voice_completion_attempts=0,transcript_end_offset_ms=2000 WHERE id=$1", captureID); err != nil {
		t.Fatal(err)
	}
	if delay, err := env.application.CompleteCaptureForTest(t.Context(), captureID); delay <= 0 || err != nil {
		t.Fatalf("incomplete transcript delay=%v err=%v", delay, err)
	}
	capture = liveKitCaptureForTest(t, q, captureID)
	if capture.VoiceCompletionAttempts != 0 || capture.VoiceCompletionFailedAt.Valid {
		t.Fatalf("delay counted as a retry: %+v", capture)
	}
	if _, err := env.pool.Exec(t.Context(), "UPDATE capture_sessions SET transcript_end_offset_ms=1000 WHERE id=$1", captureID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), "DELETE FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_official'", roomID); err != nil {
		t.Fatal(err)
	}
	maxAttempts := app.LiveKitCaptureCompletionMaxAttemptsForTest()
	for attempt := int32(1); attempt <= maxAttempts; attempt++ {
		_, err := env.application.CompleteCaptureForTest(t.Context(), captureID)
		if attempt < maxAttempts && err == nil {
			t.Fatalf("attempt %d completed early", attempt)
		}
		capture = liveKitCaptureForTest(t, q, captureID)
		if capture.VoiceCompletionAttempts != attempt {
			t.Fatalf("attempt %d recorded %d", attempt, capture.VoiceCompletionAttempts)
		}
		if attempt < maxAttempts && capture.VoiceCompletionFailedAt.Valid {
			t.Fatal("retry budget exhausted early")
		}
	}
	if !capture.VoiceCompletionFailedAt.Valid || capture.VoiceCompletionFailureCode.String != "retry_exhausted" {
		t.Fatalf("exhausted worker completion=%+v", capture)
	}
	if pendingLiveKitCapture(t, q, captureID) {
		t.Fatal("exhausted completion was selected again")
	}
	if _, err := env.application.SettleLiveKitCaptureCompletionForTest(t.Context(), captureID, 0, document.ErrNotFound); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("0-row fail swallowed cause: %v", err)
	}
	unchanged := liveKitCaptureForTest(t, q, captureID)
	if unchanged.VoiceCompletionAttempts != maxAttempts || unchanged.VoiceCompletionFailureCode.String != "retry_exhausted" {
		t.Fatalf("0-row fail mutated terminal row: %+v", unchanged)
	}
}

func seedFinalizedLiveKitCapture(t *testing.T, env *testEnv, client *http.Client, id, account string) (captureID, documentID, roomID string) {
	t.Helper()
	q := store.New(env.pool)
	direct := requestDirectRoom(client, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("direct Room: %d %v", direct.status, direct.err)
	}
	hash := sha256.Sum256([]byte(id))
	voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_completion_" + id, AccountID: account, AuthSessionID: loginSessionOf(t, env, account), RoomID: direct.roomID, ProviderRoomName: "completion-" + id, ParticipantIdentity: id, Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_completion_" + id, AccountID: account, RoomID: direct.roomID, VoiceSessionID: voice.ID, StartOffsetMs: 0})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
		t.Fatal(err)
	}
	if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{ID: "transcript_" + id, SessionID: capture.ID, AccountID: account, RoomID: direct.roomID, StartOffsetMs: 100, EndOffsetMs: 900, Text: "Save this complete transcript.", NormalizedText: "Savethiscompletetranscript", Kind: "speech"}); err != nil {
		t.Fatal(err)
	}
	if _, err = q.AdvanceCaptureTranscriptCoverage(t.Context(), store.AdvanceCaptureTranscriptCoverageParams{SessionID: capture.ID, AccountID: account, RoomID: direct.roomID, StreamID: id, Lane: "live", StartOffsetMs: 0, EndOffsetMs: 1000}); err != nil {
		t.Fatal(err)
	}
	status, _, body := requestUnifiedDocumentMultipart(t, env, client, "/v0/rooms/"+direct.roomID+"/documents/uploads", "completion-audio-"+id, map[string]string{"filename": "source.m4a", "representation_format": "m4a", "media_type": "audio/mp4"}, "source.m4a", []byte("synthetic-media"))
	if status != http.StatusCreated {
		t.Fatalf("Room audio upload status=%d body=%s", status, body)
	}
	var version uploadedDocumentRef
	decode(t, body, &version)
	if _, err = q.CreateCaptureMediaOutput(t.Context(), store.CreateCaptureMediaOutputParams{ID: "output_" + id, CaptureSessionID: capture.ID, Purpose: "final", RangeDigest: hex.EncodeToString(hash[:]), ObjectKey: "output_" + id, Filename: "source.m4a", DurationMs: 1000, SizeBytes: 15, Sha256: hex.EncodeToString(hash[:])}); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(t.Context(), "UPDATE capture_sessions SET document_id=$2,document_version_id=$3,transcript_end_offset_ms=1000,status='finalized',updated_at=clock_timestamp() WHERE id=$1", capture.ID, version.ID, version.CurrentVersion.ID); err != nil {
		t.Fatal(err)
	}
	return capture.ID, version.ID, direct.roomID
}

func liveKitCaptureForTest(t *testing.T, q *store.Queries, captureID string) store.CaptureSession {
	t.Helper()
	capture, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: captureID, AccountID: pgtype.Text{String: "account_alice", Valid: true}})
	if err != nil {
		t.Fatal(err)
	}
	return capture
}

// pendingLiveKitCapture reports whether the completion job would still
// complete captureID.
func pendingLiveKitCapture(t *testing.T, q *store.Queries, captureID string) bool {
	t.Helper()
	_, err := q.GetPendingLiveKitCaptureCompletion(t.Context(), captureID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		t.Fatal(err)
	}
	return true
}
