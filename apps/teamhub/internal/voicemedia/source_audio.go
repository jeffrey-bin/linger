package voicemedia

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/jackc/pgx/v5/pgtype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomevent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func (s *Service) saveSourceAudio(ctx context.Context, job store.GetVoiceMediaMaterializationContextRow) (store.CaptureMediaOutput, error) {
	if existing, err := s.queries.GetVoiceSourceAudio(ctx, job.CaptureSessionID); err == nil && existing.DocumentVersionID.Valid {
		return existing, nil
	}
	media, err := s.Materialize(ctx, MaterializeRequest{AccountID: job.AccountID.String, CaptureSessionID: job.CaptureSessionID,
		FromMS: job.StartOffsetMs, ThroughMS: job.EndOffsetMs, Purpose: "source"})
	if err != nil {
		return store.CaptureMediaOutput{}, err
	}
	digest, err := hex.DecodeString(media.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return store.CaptureMediaOutput{}, errors.New("invalid source audio digest")
	}
	var hash [sha256.Size]byte
	copy(hash[:], digest)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return store.CaptureMediaOutput{}, err
	}
	defer tx.Rollback(ctx)
	q := s.queries.WithTx(tx)
	output, err := q.GetVoiceSourceAudio(ctx, job.CaptureSessionID)
	if err != nil {
		return store.CaptureMediaOutput{}, err
	}
	version, err := s.documents.CreateStoredRoomUploadTx(ctx, tx, document.StoredRoomUploadInput{
		AccountID: job.AccountID.String, RoomID: job.RoomID, CommandID: "voice-source:" + job.CaptureSessionID,
		Filename: "original-recording.m4a", RepresentationFormat: "m4a", MediaType: "audio/mp4",
		Object: artifactstore.Object{Key: media.ObjectKey, Size: media.SizeBytes, SHA256: hash},
	})
	if err != nil {
		return store.CaptureMediaOutput{}, err
	}
	output, err = q.AttachCaptureMediaOutputDocument(ctx, store.AttachCaptureMediaOutputDocumentParams{
		ID: output.ID, DocumentID: pgtype.Text{String: version.DocumentID, Valid: true}, DocumentVersionID: pgtype.Text{String: version.ID, Valid: true}})
	if err != nil {
		return store.CaptureMediaOutput{}, err
	}
	capture, err := q.AttachVoiceSourceAudio(ctx, store.AttachVoiceSourceAudioParams{ID: job.CaptureSessionID,
		SourceAudioDocumentID: pgtype.Text{String: version.DocumentID, Valid: true}, SourceAudioDocumentVersionID: pgtype.Text{String: version.ID, Valid: true}})
	if err != nil {
		return store.CaptureMediaOutput{}, err
	}
	if err = roomevent.AppendCaptureSessionChanged(ctx, q, capture.TenantID, capture.RoomID, capture.CreatedByActorID, capture.ID, capture.Status); err != nil {
		return store.CaptureMediaOutput{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return store.CaptureMediaOutput{}, err
	}
	return output, nil
}

type recoveryAudio struct {
	file      *os.File
	directory string
}

func (a *recoveryAudio) close() { _ = a.file.Close(); _ = os.RemoveAll(a.directory) }

type recoveryAudioProvider interface {
	openRecoveryAudio(context.Context, store.CaptureMediaOutput) (*recoveryAudio, error)
}

func (m *HLSMaterializer) openRecoveryAudio(ctx context.Context, source store.CaptureMediaOutput) (_ *recoveryAudio, resultErr error) {
	directory, err := os.MkdirTemp("", ".voice-recovery-*")
	if err != nil {
		return nil, err
	}
	defer func() {
		if resultErr != nil {
			_ = os.RemoveAll(directory)
		}
	}()
	input := filepath.Join(directory, "source.m4a")
	if err = m.downloadOutput(ctx, source, input); err != nil {
		return nil, err
	}
	output := filepath.Join(directory, "source.pcm")
	if err = exec.CommandContext(ctx, m.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", output).Run(); err != nil {
		return nil, fmt.Errorf("decode recovery audio: %w", err)
	}
	file, err := os.Open(output)
	if err != nil {
		return nil, err
	}
	return &recoveryAudio{file: file, directory: directory}, nil
}
