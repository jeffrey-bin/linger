package integration_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func TestVoiceCompletionRetriesOneRoomWithoutBlockingAnother(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t, nil, starting(app.JobQueue))
	q := store.New(env.pool)
	var rooms []string
	var outputs [][3]string
	// A completion is announced only in a Direct Room, and the one Human has
	// one Direct Room per Agent, so each Room pairs the Human with its own Agent.
	seedPeerAgent(t, env, "actor_completion_peer")
	agents := []string{"actor_completion_peer", "actor_acme_official"}
	for i, id := range []string{"blocked", "healthy"} {
		direct := requestDirectRoom(alice, env.server.URL, agents[i])
		if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
			t.Fatalf("direct Room: %d %v", direct.status, direct.err)
		}
		roomID := direct.roomID
		rooms = append(rooms, roomID)
		account := "account_alice"
		if i > 0 {
			// Each Capture belongs to its own login session of the Human.
			env.login("alice", alicePassword)
		}
		hash := sha256.Sum256([]byte(id))
		voice, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{ID: "voice_completion_" + id, AccountID: account, AuthSessionID: loginSessionOf(t, env, account), RoomID: roomID, ProviderRoomName: "completion-" + id, ParticipantIdentity: id, Purpose: "hardware_control"})
		if err != nil {
			t.Fatal(err)
		}
		capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_completion_" + id, AccountID: account, RoomID: roomID, VoiceSessionID: voice.ID, StartOffsetMs: 0})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = q.TransitionLiveKitCaptureStatus(t.Context(), store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "recording"}); err != nil {
			t.Fatal(err)
		}
		if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{ID: "transcript_" + id, SessionID: capture.ID, AccountID: account, RoomID: roomID, StartOffsetMs: 100, EndOffsetMs: 900, Text: "Save this complete transcript.", NormalizedText: "Savethiscompletetranscript", Kind: "speech"}); err != nil {
			t.Fatal(err)
		}
		if _, err = q.AdvanceCaptureTranscriptCoverage(t.Context(), store.AdvanceCaptureTranscriptCoverageParams{SessionID: capture.ID, AccountID: account, RoomID: roomID, StreamID: id, Lane: "live", StartOffsetMs: 0, EndOffsetMs: 1000}); err != nil {
			t.Fatal(err)
		}
		status, _, body := requestUnifiedDocumentMultipart(t, env, alice, "/v0/rooms/"+roomID+"/documents/uploads", "completion-audio-"+id, map[string]string{"filename": "source.m4a", "representation_format": "m4a", "media_type": "audio/mp4"}, "source.m4a", []byte("synthetic-media"))
		if status != http.StatusCreated {
			t.Fatalf("Room audio upload status=%d body=%s", status, body)
		}
		var version uploadedDocumentRef
		decode(t, body, &version)
		if _, err = q.CreateCaptureMediaOutput(t.Context(), store.CreateCaptureMediaOutputParams{ID: "output_" + id, CaptureSessionID: capture.ID, Purpose: "final", RangeDigest: hex.EncodeToString(hash[:]), ObjectKey: "output_" + id, Filename: "source.m4a", DurationMs: 1000, SizeBytes: 15, Sha256: hex.EncodeToString(hash[:])}); err != nil {
			t.Fatal(err)
		}
		outputs = append(outputs, [3]string{capture.ID, version.ID, version.CurrentVersion.ID})
	}
	// The Human remains authorized; only the first Room's Agent is unavailable.
	var agentTenantID, agentRole, agentAddedBy, agentEpochID string
	var agentJoinedAt time.Time
	if err := env.pool.QueryRow(t.Context(), `DELETE FROM room_members WHERE room_id=$1 AND actor_id='actor_completion_peer'
 RETURNING tenant_id,role,added_by_actor_id,joined_at,membership_epoch_id`, rooms[0]).Scan(
		&agentTenantID, &agentRole, &agentAddedBy, &agentJoinedAt, &agentEpochID); err != nil {
		t.Fatal(err)
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for i, output := range outputs {
		if _, err = tx.Exec(t.Context(), "UPDATE capture_sessions SET document_id=$2,document_version_id=$3,transcript_end_offset_ms=1000,status='finalized',updated_at=clock_timestamp()+$4::interval WHERE id=$1", output[0], output[1], output[2], []string{"-1 minute", "0 seconds"}[i]); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, output := range outputs {
		queueVoiceJob(t, env.pool, voicemedia.CaptureCompletionArgs{CaptureSessionID: output[0]})
	}

	deadline := time.Now().Add(4 * time.Second)
	for {
		capture, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: "capture_completion_healthy", AccountID: pgtype.Text{String: "account_alice", Valid: true}})
		if err != nil {
			t.Fatal(err)
		}
		if capture.TranscriptDocumentVersionID.Valid {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("one unavailable Agent starved the other Room's recording completion")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := countRows(t, env, "SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official'", rooms[1]); got != 1 {
		t.Fatalf("healthy completion Message count=%d", got)
	}
	blocked, err := q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: "capture_completion_blocked", AccountID: pgtype.Text{String: "account_alice", Valid: true}})
	if err != nil || blocked.Status != "finalized" || blocked.TranscriptDocumentVersionID.Valid {
		t.Fatalf("blocked recording was discarded or falsely completed: %+v %v", blocked, err)
	}
	if blocked.VoiceCompletionAttempts < 1 {
		t.Fatal("failed completion did not count its attempt")
	}
	waitVoiceJobQueued(t, env.pool, voicemedia.CaptureCompletionArgs{CaptureSessionID: "capture_completion_blocked"}, "failed completion")
	if blocked.VoiceCompletionFailedAt.Valid {
		t.Fatal("retryable completion was marked terminal")
	}
	if _, err = env.pool.Exec(t.Context(), `INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id,joined_at,membership_epoch_id)
 VALUES($1,$2,'actor_completion_peer',$3,$4,$5,$6)`, rooms[0], agentTenantID, agentRole, agentAddedBy, agentJoinedAt, agentEpochID); err != nil {
		t.Fatal(err)
	}
	queueVoiceJob(t, env.pool, voicemedia.CaptureCompletionArgs{CaptureSessionID: "capture_completion_blocked"})
	deadline = time.Now().Add(4 * time.Second)
	for {
		blocked, err = q.GetCaptureSessionForAccount(t.Context(), store.GetCaptureSessionForAccountParams{ID: "capture_completion_blocked", AccountID: pgtype.Text{String: "account_alice", Valid: true}})
		if err != nil {
			t.Fatal(err)
		}
		if blocked.TranscriptDocumentVersionID.Valid {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("recovered Agent did not receive the retained completion")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got := countRows(t, env, "SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_completion_peer'", rooms[0]); got != 1 {
		t.Fatalf("recovered completion Message count=%d", got)
	}
	if blocked.VoiceCompletionFailedAt.Valid {
		t.Fatal("recovered completion stayed terminal")
	}

}
