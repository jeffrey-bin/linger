package voicemedia

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

func TestCaptureProjectionWaitsForTranscriptAndMessageTransaction(t *testing.T) {
	record := store.CaptureSession{Status: "finalized", DocumentVersionID: pgtype.Text{String: "audio-version", Valid: true}}
	if got := captureModel(record, store.VoiceMediaEpoch{}); got.Status != "finalizing" {
		t.Fatalf("status=%s", got.Status)
	}
	record.TranscriptDocumentVersionID = pgtype.Text{String: "transcript-version", Valid: true}
	if got := captureModel(record, store.VoiceMediaEpoch{}); got.Status != "finalized" || got.TranscriptDocumentVersionID != "transcript-version" {
		t.Fatalf("completion projection=%+v", got)
	}
}

func TestCaptureProjectionPreservesRequestedStartBeforeMediaAlignment(t *testing.T) {
	for _, requested := range []int64{0, 2000} {
		record := store.CaptureSession{
			Status:                           "recording",
			CreatedAt:                        pgtype.Timestamptz{Time: time.UnixMilli(9000), Valid: true},
			TranscriptStartOffsetMs:          pgtype.Int8{Int64: 9000, Valid: true},
			RequestedTranscriptStartOffsetMs: requested,
		}
		model := captureModel(record, store.VoiceMediaEpoch{})
		if model.RequestedStartOffsetMS != requested {
			t.Fatalf("requested start was replaced by the media start: want=%d", requested)
		}
		if model.CreatedAt != record.CreatedAt.Time {
			t.Fatal("media-aligned creation time changed")
		}
	}
}

func TestIssuePublisherGrantRecreatesSessionBeforeMintingCredential(t *testing.T) {
	provider := &publisherGrantProvider{}
	service := &Service{provider: provider}
	record := store.VoiceSession{
		ID:                  "voice-session-1",
		ProviderRoomName:    "voice-voice-session-1",
		ParticipantIdentity: "publisher-voice-session-1",
	}

	grant, err := service.issuePublisherGrant(t.Context(), record, 4)
	if err != nil {
		t.Fatal(err)
	}
	if grant.Generation != 4 {
		t.Fatalf("grant generation=%d want=4", grant.Generation)
	}
	if !reflect.DeepEqual(provider.calls, []string{"ensure", "grant"}) {
		t.Fatalf("provider calls=%v want=[ensure grant]", provider.calls)
	}
}

func TestIssuePublisherGrantDoesNotMintCredentialWhenSessionRestoreFails(t *testing.T) {
	provider := &publisherGrantProvider{ensureErr: errors.New("restore failed")}
	service := &Service{provider: provider}

	_, err := service.issuePublisherGrant(t.Context(), store.VoiceSession{}, 1)
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("issuePublisherGrant() error=%v want ErrProviderUnavailable", err)
	}
	if !reflect.DeepEqual(provider.calls, []string{"ensure"}) {
		t.Fatalf("provider calls=%v want=[ensure]", provider.calls)
	}
}

func TestActiveVoiceSessionConstraintIsAProductConflict(t *testing.T) {
	err := &pgconn.PgError{
		Code: "23505", ConstraintName: "voice_sessions_active_auth_session_idx",
	}
	if !isActiveVoiceSessionConflict(err) {
		t.Fatal("active VoiceSession unique violation was not classified")
	}
	if isActiveVoiceSessionConflict(&pgconn.PgError{
		Code: "23505", ConstraintName: "voice_sessions_pkey",
	}) {
		t.Fatal("unrelated unique violation was classified as an active VoiceSession conflict")
	}
}

func TestInitialMediaStartRejectsMissingAndPreRequestClock(t *testing.T) {
	requested := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	for _, started := range []time.Time{{}, requested.Add(-time.Millisecond)} {
		if _, err := initialMediaStart(requested, started); !errors.Is(err, ErrProviderUnavailable) {
			t.Fatalf("untrusted media start accepted: start=%v err=%v", started, err)
		}
	}
	started := requested.Add(5 * time.Second)
	if got, err := initialMediaStart(requested, started); err != nil || !got.Equal(started) {
		t.Fatalf("actual media start changed: got=%v err=%v", got, err)
	}
}

func TestCaptureStartUsesServerVoiceSessionEpoch(t *testing.T) {
	created := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	if got := captureStartOffset(created, created.Add(37*time.Second+420*time.Millisecond)); got != 37_420 {
		t.Fatalf("captureStartOffset()=%d want=37420", got)
	}
	if got := captureStartOffset(created, created.Add(-time.Second)); got != 0 {
		t.Fatalf("negative captureStartOffset()=%d want=0", got)
	}
}

type publisherGrantProvider struct {
	calls     []string
	ensureErr error
}

func (p *publisherGrantProvider) EnsureSession(context.Context, providerSession) error {
	p.calls = append(p.calls, "ensure")
	return p.ensureErr
}

func (p *publisherGrantProvider) IssuePublisherGrant(_ context.Context, _ providerSession, generation int64) (PublisherGrant, error) {
	p.calls = append(p.calls, "grant")
	return PublisherGrant{Generation: generation}, nil
}

func (*publisherGrantProvider) RevokePublisher(context.Context, providerSession) error {
	return nil
}

func (*publisherGrantProvider) StartCapture(context.Context, providerCapture) (providerObservation, error) {
	return providerObservation{}, nil
}

func (*publisherGrantProvider) ObserveCapture(context.Context, providerCapture) (providerObservation, error) {
	return providerObservation{}, nil
}

func (*publisherGrantProvider) StopCapture(context.Context, providerCapture) (providerObservation, error) {
	return providerObservation{}, nil
}

type recoveryASR struct{}

func (recoveryASR) TranscribeArchivePCM(context.Context, []byte) ([]voicetranscription.StreamingResult, error) {
	return nil, nil
}

func TestTranscriptRecoveryRunsWithArchiveASRAndAudioOnly(t *testing.T) {
	service := &Service{materializer: &HLSMaterializer{}}
	if service.recoversTranscripts() {
		t.Fatal("transcript recovery ran without archive ASR")
	}
	service.SetArchiveTranscriber(recoveryASR{}, strings.TrimSpace)
	if !service.recoversTranscripts() {
		t.Fatal("transcript recovery did not run with archive ASR and recovery audio")
	}
}
