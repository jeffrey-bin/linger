package voicemedia

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var (
	ErrRecordingNotFound = errors.New("voice recording epoch is not found")
	ErrRecordingClosed   = errors.New("voice recording epoch no longer accepts media")
	ErrRecordingConflict = errors.New("voice recording object conflicts with stored media")
	ErrRecordingInvalid  = errors.New("voice recording object is invalid")
)

var (
	stagingObjectKeyPattern = regexp.MustCompile(`^(voice-staging/[A-Za-z0-9_-]+/epoch-[0-9]+)(_[0-9]{5,}\.ts|\.m3u8)$`)
	stagingPrefixPattern    = regexp.MustCompile(`^voice-staging/[A-Za-z0-9_-]+/$`)
)

// LocalStagingStore keeps the HLS objects Voice Runtime records as files under
// a local directory, one file per staging key, until the Capture's staging
// cleanup removes its directory. The file system is the only index.
type LocalStagingStore struct {
	queries *store.Queries
	pool    *pgxpool.Pool
	root    string
}

// NewLocalStagingStore stores staging keys as paths below root.
func NewLocalStagingStore(pool *pgxpool.Pool, root string) *LocalStagingStore {
	return &LocalStagingStore{queries: store.New(pool), pool: pool, root: root}
}

func (s *LocalStagingStore) path(key string) string {
	return filepath.Join(s.root, filepath.FromSlash(key))
}

// Open reads one staging file; a key outside the staging layout does not exist.
func (s *LocalStagingStore) Open(_ context.Context, key string) (io.ReadCloser, error) {
	if !stagingObjectKeyPattern.MatchString(key) {
		return nil, fmt.Errorf("read voice media staging object %q: %w", key, os.ErrNotExist)
	}
	return os.Open(s.path(key))
}

// List returns the keys of one epoch prefix after the given key, in key order.
func (s *LocalStagingStore) List(_ context.Context, prefix, after string) ([]string, error) {
	directory := path.Dir(prefix)
	entries, err := os.ReadDir(s.path(directory))
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	keys := []string{}
	for _, entry := range entries {
		key := directory + "/" + entry.Name()
		if match := stagingObjectKeyPattern.FindStringSubmatch(key); match != nil && match[1] == prefix && key > after {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

// DeletePrefix removes a Capture's staging directory once nothing reads it.
func (s *LocalStagingStore) DeletePrefix(_ context.Context, prefix string) error {
	if !stagingPrefixPattern.MatchString(prefix) {
		return ErrRecordingInvalid
	}
	return os.RemoveAll(s.path(prefix))
}

// Put stores one recorded segment or playlist while its epoch still records.
// Segments are immutable; a replay must carry identical bytes. A playlist
// follows the growing recording, so a newer upload replaces it.
func (s *LocalStagingStore) Put(ctx context.Context, key string, body []byte) error {
	match := stagingObjectKeyPattern.FindStringSubmatch(key)
	if match == nil || len(body) == 0 {
		return ErrRecordingInvalid
	}
	playlist := strings.HasSuffix(key, ".m3u8")
	if (playlist && len(body) > maximumPlaylistBytes) || (!playlist && len(body) > maximumSegmentBytes) {
		return ErrRecordingInvalid
	}
	epoch, err := s.queries.GetVoiceMediaEpochByStagingPrefix(ctx, match[1])
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRecordingNotFound
	}
	if err != nil {
		return err
	}
	if epoch.RecorderState.Valid && epoch.RecorderState.String != "active" {
		return ErrRecordingClosed
	}
	target := s.path(key)
	if err = os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".upload-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err = temporary.Write(body); err != nil {
		_ = temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	if playlist {
		return os.Rename(temporary.Name(), target)
	}
	// A link never replaces an existing segment, so concurrent uploads of one
	// key keep the first bytes and the others compare against them.
	if err = os.Link(temporary.Name(), target); errors.Is(err, os.ErrExist) {
		existing, readErr := os.ReadFile(target)
		if readErr != nil {
			return readErr
		}
		if !bytes.Equal(existing, body) {
			return ErrRecordingConflict
		}
		return nil
	}
	return err
}

// RecordingReport is one Voice Runtime recorder state change for an epoch.
type RecordingReport struct {
	StagingPrefix     string
	State             string
	StartedAt         *time.Time
	ArchivedThroughMS int64
	FailureCode       string
}

// ReportRecording stores the recorder state the provider observes. Reports
// after a terminal state are ignored.
func (s *LocalStagingStore) ReportRecording(ctx context.Context, report RecordingReport) error {
	if report.ArchivedThroughMS < 0 || (report.State != "active" && report.State != "available" && report.State != "failed") ||
		(report.State != "failed" && report.StartedAt == nil) {
		return ErrRecordingInvalid
	}
	params := store.ReportVoiceMediaRecorderParams{
		RecorderState: pgtype.Text{String: report.State, Valid: true}, StagingPrefix: report.StagingPrefix,
		RecorderArchivedThroughMs: report.ArchivedThroughMS,
	}
	if report.StartedAt != nil {
		params.RecorderStartedAt = pgtype.Timestamptz{Time: report.StartedAt.UTC(), Valid: true}
	}
	if report.FailureCode != "" {
		params.RecorderFailureCode = pgtype.Text{String: report.FailureCode, Valid: true}
	}
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		epoch, err := s.queries.WithTx(tx).ReportVoiceMediaRecorder(ctx, params)
		if err != nil || report.State == "active" {
			return err
		}
		// Reconciliation observes the ended recorder from the stored report.
		return enqueue(ctx, tx, CaptureReconcileArgs{CaptureSessionID: epoch.CaptureSessionID})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		if _, getErr := s.queries.GetVoiceMediaEpochByStagingPrefix(ctx, report.StagingPrefix); errors.Is(getErr, pgx.ErrNoRows) {
			return ErrRecordingNotFound
		}
		return nil
	}
	return err
}
