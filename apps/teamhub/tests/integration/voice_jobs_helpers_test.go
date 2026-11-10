package integration_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// captureSpeech is one live final of a Capture, on the VoiceSession clock.
type captureSpeech struct {
	ID, SessionID, AccountID, RoomID string
	StartOffsetMs, EndOffsetMs       int64
	Text, NormalizedText, Kind       string
	SpeakerID                        pgtype.Text
}

// createCaptureSpeech writes a live final of a Capture as the observation
// callback does, through the same writable-Capture gate.
func createCaptureSpeech(ctx context.Context, q *store.Queries, row captureSpeech) (store.VoiceTranscriptSegment, error) {
	capture, err := q.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{
		ID: row.SessionID, AccountID: pgtype.Text{String: row.AccountID, Valid: true},
	})
	if err != nil {
		return store.VoiceTranscriptSegment{}, err
	}
	return q.CreateVoiceTranscriptSegment(ctx, store.CreateVoiceTranscriptSegmentParams{
		ID: row.ID, EventID: "event_" + row.ID, VoiceSessionID: capture.VoiceSessionID.String,
		CaptureSessionID: pgtype.Text{String: capture.ID, Valid: true}, Lane: "live",
		StartOffsetMs: row.StartOffsetMs, EndOffsetMs: row.EndOffsetMs,
		Text: row.Text, NormalizedText: row.NormalizedText, Kind: row.Kind, SpeakerID: row.SpeakerID,
		AccountID: row.AccountID, RoomID: row.RoomID,
	})
}

// queueVoiceJob queues or wakes a voice job for work a test wrote directly,
// as the commit that writes it in production does.
func queueVoiceJob(t *testing.T, pool *pgxpool.Pool, job river.JobArgs) {
	t.Helper()
	if err := pgx.BeginFunc(t.Context(), pool, func(tx pgx.Tx) error {
		return jobs.InsertOrWakeTx(t.Context(), tx, job, nil)
	}); err != nil {
		t.Fatal(err)
	}
}

// requireVoiceJobQueued checks that a commit queued or woke the voice job that
// does the work it created, so the job runs without waiting for a poll.
func requireVoiceJobQueued(t *testing.T, pool *pgxpool.Pool, job river.JobArgs, commit string) {
	t.Helper()
	if !voiceJobQueued(t, pool, job) {
		t.Fatalf("%s did not queue %s", commit, job.Kind())
	}
}

// waitVoiceJobQueued waits for a running voice job to snooze itself back into
// the queue: its step commits before River records the snooze.
func waitVoiceJobQueued(t *testing.T, pool *pgxpool.Pool, job river.JobArgs, step string) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for !voiceJobQueued(t, pool, job) {
		if time.Now().After(deadline) {
			t.Fatalf("%s did not queue %s", step, job.Kind())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func voiceJobQueued(t *testing.T, pool *pgxpool.Pool, job river.JobArgs) bool {
	t.Helper()
	args, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	var queued bool
	if err := pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM river_job
		WHERE kind=$1 AND args @> $2::jsonb AND state IN ('available','scheduled','pending'))`, job.Kind(), args).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	return queued
}
