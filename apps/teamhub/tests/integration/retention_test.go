package integration_test

import (
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func TestRetentionDeletesExpiredRows(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	cfg := config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = integrationArtifactRoot(t)
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
	})
	exec := func(sql string, arguments ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, arguments...); err != nil {
			t.Fatal(err)
		}
	}
	count := func(sql string, arguments ...any) int {
		t.Helper()
		var rows int
		if err := pool.QueryRow(ctx, sql, arguments...).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		return rows
	}

	// Prepare the rows with River off, then start a second App whose retention
	// job runs on start.
	prepared, err := newIntegrationApp(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(prepared.Handler())
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Retention "+suffix, "retention-room-"+suffix)
	env.createMessage(alice, roomID, "old one", "retention-old-one-"+suffix)
	env.createMessage(alice, roomID, "old two", "retention-old-two-"+suffix)

	env.createMessage(alice, roomID, "fresh", "retention-fresh-"+suffix)
	server.Close()
	prepared.Close()

	exec(`INSERT INTO auth_sessions(id,account_id,token_hash,created_at,expires_at,revoked_at,revoked_reason) VALUES
		($1,'account_alice',sha256(convert_to($1,'UTF8')),now()-interval '2 days',now()-interval '1 day',NULL,NULL),
		($2,'account_alice',sha256(convert_to($2,'UTF8')),now(),now()+interval '1 hour',now(),'logout')`,
		"retention-expired-"+suffix, "retention-revoked-"+suffix)
	exec(`INSERT INTO room_reminders(
			id,tenant_id,room_id,created_by_actor_id,instruction,name,timezone,
			cadence_kind,run_at,hour,minute,enabled,next_run_at,updated_at
		) VALUES
		($1,$4,$5,'actor_acme_alice','Done','Done','UTC','once',now()-interval '8 days',NULL,NULL,false,NULL,now()-interval '8 days'),
		($2,$4,$5,'actor_acme_alice','Recent','Recent','UTC','once',now()-interval '1 day',NULL,NULL,false,NULL,now()-interval '1 day'),
		($3,$4,$5,'actor_acme_alice','Daily','Daily','UTC','daily',NULL,9,0,false,NULL,now()-interval '8 days')`,
		"retention-once-done-"+suffix, "retention-once-recent-"+suffix, "retention-daily-"+suffix, acmeTenant, roomID)
	exec(`INSERT INTO routine_event_deliveries(routine_id,source,upstream_event_id,created_at) VALUES
		($1,'gmail','old',now()-interval '31 days'),($1,'gmail','recent',now()-interval '1 day')`,
		"retention-daily-"+suffix)
	// Voice: a dictation session closed 8 days ago goes whole. A recording
	// session closed as long ago stays with its recordings and what they own,
	// but loses the words spoken outside the recordings and the
	// working state of the recording that failed 8 days ago; the one still
	// recovering keeps it. A session closed yesterday keeps everything.
	dictationID, recordingID, recentVoiceID := "retention-dictation-"+suffix, "retention-recording-"+suffix, "retention-voice-recent-"+suffix
	failedCaptureID, recoveringCaptureID := "retention-capture-failed-"+suffix, "retention-capture-recovering-"+suffix
	exec(`INSERT INTO voice_sessions(id,tenant_id,room_id,created_by_actor_id,status,provider_room_name,
			participant_identity,purpose,closed_at)
		SELECT voice.id,$4,$5,'actor_acme_alice','closed',voice.id,voice.id,
			voice.purpose,voice.closed_at
		FROM (VALUES ($1,'chat_dictation',now()-interval '8 days'),($2,'hardware_control',now()-interval '8 days'),
			($3,'chat_dictation',now()-interval '1 day')) AS voice(id,purpose,closed_at)`,
		dictationID, recordingID, recentVoiceID, acmeTenant, roomID)
	exec(`INSERT INTO capture_sessions(id,tenant_id,room_id,created_by_actor_id,status,voice_session_id,
			requested_transcript_start_offset_ms,updated_at) VALUES
		($1,$3,$4,'actor_acme_alice','failed',$5,0,now()-interval '8 days'),
		($2,$3,$4,'actor_acme_alice','recovering',$5,0,now()-interval '8 days')`,
		failedCaptureID, recoveringCaptureID, acmeTenant, roomID, recordingID)
	exec(`INSERT INTO voice_transcript_segments(id,event_id,voice_session_id,capture_session_id,media_epoch,lane,
			start_offset_ms,end_offset_ms,text,normalized_text,kind)
		SELECT segment.id,segment.id,segment.voice,segment.capture,0,'live',
			segment.start_ms,segment.start_ms+1000,'words','words',segment.kind
		FROM (VALUES ($1,$5,NULL,0,'dictation_turn'),($2,$6,NULL,0,'speech'),($3,$6,$7,1000,'speech'),
			($4,$8,NULL,0,'dictation_turn')) AS segment(id,voice,capture,start_ms,kind)`,
		"retention-segment-dictation-"+suffix, "retention-segment-outside-"+suffix,
		"retention-segment-recorded-"+suffix, "retention-segment-recent-"+suffix,
		dictationID, recordingID, failedCaptureID, recentVoiceID)
	for _, captureID := range []string{failedCaptureID, recoveringCaptureID} {
		exec(`UPDATE capture_sessions SET transcript_recovery_status='failed',transcript_recovery_total_ms=1000 WHERE id=$1`, captureID)
		exec(`INSERT INTO voice_transcript_uncertainties(capture_session_id,event_id,start_offset_ms,end_offset_ms,reason)
			VALUES($1,'retention-gap',0,1000,'input_gap')`, captureID)
	}

	// Memory: a revoked Agent's memory goes while an active Agent's stays.
	revokedAgentID, activeAgentID := "retention-revoked-agent-"+suffix, "retention-active-agent-"+suffix
	insertRuntimeRegistrationFixture(t, pool, revokedAgentID, "revoked")
	insertRuntimeRegistrationFixture(t, pool, activeAgentID, "active")
	exec(`INSERT INTO agent_memories(agent_id,revision,document) VALUES($1,1,'{}'),($2,1,'{}')`, revokedAgentID, activeAgentID)
	// The voice rules register with voice media; a stand-in plane turns it on.
	swept, err := newIntegrationApp(ctx, cfg, starting(app.JobQueue), withVoiceMedia(voicemedia.New(pool, nil, nil)),
		skipping(app.VoiceJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(swept.Close)
	server = httptest.NewServer(swept.Handler())
	registerIntegrationServerCleanup(t, server)
	env.server = server

	// Every rule must run cleanly, including the ones this test does not seed.
	deadline := time.Now().Add(15 * time.Second)
	for {
		var state, jobErrors string
		err := pool.QueryRow(ctx, `
			SELECT state::text, coalesce(errors::text,'') FROM river_job
			WHERE kind='maintenance.retention' ORDER BY id DESC LIMIT 1`).Scan(&state, &jobErrors)
		if err == nil && state == "completed" {
			break
		}
		if err == nil && jobErrors != "" {
			t.Fatalf("retention job state=%s errors=%s", state, jobErrors)
		}
		if time.Now().After(deadline) {
			t.Fatalf("retention job did not complete: state=%q err=%v", state, err)
		}
		time.Sleep(20 * time.Millisecond)
	}

	for _, check := range []struct {
		name string
		sql  string
		args []any
		want int
	}{
		{"expired and revoked Sessions", `SELECT count(*) FROM auth_sessions WHERE id IN ($1,$2)`,
			[]any{"retention-expired-" + suffix, "retention-revoked-" + suffix}, 0},
		{"finished one-shot Routine", `SELECT count(*) FROM room_reminders WHERE id=$1`,
			[]any{"retention-once-done-" + suffix}, 0},
		{"recent one-shot and disabled daily Routines", `SELECT count(*) FROM room_reminders WHERE id IN ($1,$2)`,
			[]any{"retention-once-recent-" + suffix, "retention-daily-" + suffix}, 2},
		{"Routine event deliveries", `SELECT count(*) FROM routine_event_deliveries WHERE routine_id=$1`,
			[]any{"retention-daily-" + suffix}, 1},
		{"dictation session closed 8 days ago", `SELECT count(*) FROM voice_sessions WHERE id=$1`,
			[]any{dictationID}, 0},
		{"recording session and its recordings", `SELECT
			(SELECT count(*) FROM voice_sessions WHERE id=$1)+(SELECT count(*) FROM capture_sessions WHERE voice_session_id=$1)
			+(SELECT count(*) FROM capture_sessions WHERE id IN ($2,$3) AND transcript_recovery_status='failed')`,
			[]any{recordingID, failedCaptureID, recoveringCaptureID}, 5},
		{"only the recorded segment of sessions closed 8 days ago", `SELECT (
			array(SELECT id FROM voice_transcript_segments WHERE voice_session_id IN ($1,$2))
			=ARRAY[$3]::text[])::int`,
			[]any{dictationID, recordingID, "retention-segment-recorded-" + suffix}, 1},
		{"session closed yesterday and its segment", `SELECT
			(SELECT count(*) FROM voice_sessions WHERE id=$1)+(SELECT count(*) FROM voice_transcript_segments WHERE voice_session_id=$1)`,
			[]any{recentVoiceID}, 2},
		{"working state of the recording that failed 8 days ago",
			`SELECT count(*) FROM voice_transcript_uncertainties WHERE capture_session_id=$1`,
			[]any{failedCaptureID}, 0},
		{"working state of the recording still recovering",
			`SELECT count(*) FROM voice_transcript_uncertainties WHERE capture_session_id=$1`,
			[]any{recoveringCaptureID}, 1},
		{"memory of the revoked Agent", `SELECT count(*) FROM agent_memories WHERE agent_id=$1`,
			[]any{revokedAgentID}, 0},
		{"memory of the active Agent", `SELECT count(*) FROM agent_memories WHERE agent_id=$1`,
			[]any{activeAgentID}, 1},
	} {
		if got := count(check.sql, check.args...); got != check.want {
			t.Errorf("%s: %d rows, want %d", check.name, got, check.want)
		}
	}
}
