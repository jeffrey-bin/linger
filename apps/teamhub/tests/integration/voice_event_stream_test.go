package integration_test

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// These tests exercise database-backed projections, not audio materialization.
// Keep real GetCapture queries without requiring ffmpeg or starting media workers.
type voiceEventReadMedia struct {
	voicemedia.Plane
	service *voicemedia.Service
}

func (m *voiceEventReadMedia) GetCapture(ctx context.Context, accountID, id string) (voicemedia.Capture, error) {
	return m.service.GetCapture(ctx, accountID, id)
}

func newVoiceEventStreamEnv(t *testing.T) (*testEnv, *http.Client, *http.Client, store.VoiceSession) {
	t.Helper()
	media := &voiceEventReadMedia{}
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, func(cfg *config.Config) {
		cfg.SSEHeartbeatInterval = 200 * time.Millisecond
	}, withVoiceMedia(media))
	media.service = voicemedia.New(env.pool, nil, nil)
	room := env.createRoom(alice, acmeTenant, "Voice events", "voice-events")
	voice, err := store.New(env.pool).CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{
		ID: "voice_events_test", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: room, ProviderRoomName: "voice-events", ParticipantIdentity: "voice-events", Purpose: "hardware_control",
	})
	if err != nil {
		t.Fatal(err)
	}
	// A Voice Session belongs to the login session that started it, so another
	// browser of the same Human is a foreign caller.
	return env, alice, env.login("alice", alicePassword), voice
}

func voiceEventTranscripts(page httpapi.VoiceEventPage) []string {
	ids := []string{}
	for _, item := range page.Items {
		if item.Transcript != nil {
			ids = append(ids, item.Transcript.EventId)
		}
	}
	return ids
}

// writeLockedVoiceSegment writes a segment the way the observation callback
// does: under the VoiceSession row lock, held until the caller commits.
func writeLockedVoiceSegment(ctx context.Context, tx pgx.Tx, sessionID, id string, start int64) error {
	q := store.New(tx)
	if _, err := q.LockVoiceSession(ctx, sessionID); err != nil {
		return err
	}
	_, err := q.CreateVoiceTranscriptSegment(ctx, store.CreateVoiceTranscriptSegmentParams{ID: id, EventID: id, VoiceSessionID: sessionID, Lane: "live", StartOffsetMs: start, EndOffsetMs: start + 50, Text: id, NormalizedText: id, Kind: "speech"})
	return err
}

func readVoiceEvents(t *testing.T, env *testEnv, client *http.Client, voice, cursor string) httpapi.VoiceEventPage {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/voice-sessions/"+voice+"/events?after="+url.QueryEscape(cursor), nil, "")
	if status != http.StatusOK {
		t.Fatalf("voice events=%d %s", status, body)
	}
	var page httpapi.VoiceEventPage
	decode(t, body, &page)
	return page
}

func TestVoiceEventCursorRecoversLateCommitAndExcludesRollback(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _, voice := newVoiceEventStreamEnv(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	first, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(ctx)
	if err = writeLockedVoiceSegment(ctx, first, voice.ID, "accepted_first_committed_last", 100); err != nil {
		t.Fatal(err)
	}
	// The second writer waits on the session lock, so its seq is drawn after
	// the first writer commits and the cursor can never skip the first.
	second := make(chan error, 1)
	go func() {
		tx, beginErr := env.pool.Begin(ctx)
		if beginErr != nil {
			second <- beginErr
			return
		}
		defer tx.Rollback(ctx)
		if writeErr := writeLockedVoiceSegment(ctx, tx, voice.ID, "committed_second", 300); writeErr != nil {
			second <- writeErr
			return
		}
		second <- tx.Commit(ctx)
	}()
	page := readVoiceEvents(t, env, alice, voice.ID, "")
	if got := voiceEventTranscripts(page); len(got) != 0 {
		t.Fatalf("uncommitted event escaped: %v", got)
	}
	if last := page.Items[len(page.Items)-1]; last.Session == nil || last.Session.Id != voice.ID {
		t.Fatalf("page has no session snapshot: %+v", page)
	}
	if err = first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-second; err != nil {
		t.Fatal(err)
	}
	late := readVoiceEvents(t, env, alice, voice.ID, page.NextCursor)
	if got := voiceEventTranscripts(late); len(got) != 2 || got[0] != "accepted_first_committed_last" || got[1] != "committed_second" {
		t.Fatalf("late commit lost or out of order: %v", got)
	}
	rollback, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = writeLockedVoiceSegment(ctx, rollback, voice.ID, "rolled_back", 500); err != nil {
		t.Fatal(err)
	}
	if _, err = rollback.Exec(ctx, "SET CONSTRAINTS ALL IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if err = rollback.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readVoiceEvents(t, env, alice, voice.ID, late.NextCursor); len(voiceEventTranscripts(got)) != 0 || got.NextCursor != late.NextCursor {
		t.Fatalf("rollback emitted: %+v", got)
	}
	// Partial traffic must not move the transcript cursor.
	for n := 0; n < 20; n++ {
		if _, err = env.pool.Exec(ctx, "UPDATE voice_sessions SET latest_partial_text=$2,latest_partial_start_offset_ms=100,latest_partial_end_offset_ms=200,latest_partial_updated_at=clock_timestamp() WHERE id=$1", voice.ID, fmt.Sprintf("partial-%d", n)); err != nil {
			t.Fatal(err)
		}
	}
	if got := readVoiceEvents(t, env, alice, voice.ID, late.NextCursor); len(voiceEventTranscripts(got)) != 0 || got.NextCursor != late.NextCursor {
		t.Fatalf("partial changed the transcript cursor: %+v", got)
	}
	// Deleted Rooms must revoke both bootstrap HTTP and event/SSE reads.
	if _, err = env.pool.Exec(ctx, "UPDATE rooms SET deletion_started_at=now(),deletion_started_by_actor_id=$2,deleted_at=now(),deleted_by_actor_id=$2 WHERE id=$1", voice.RoomID, voice.CreatedByActorID); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/transcript-events", "/events", "/events/stream"} {
		status, _, _ := env.request(alice, http.MethodGet, "/v0/voice-sessions/"+voice.ID+path, nil, "")
		if status != http.StatusNotFound {
			t.Fatalf("deleted Room voice access %s=%d", path, status)
		}
	}
}

func TestVoiceEventStreamSendsTranscriptCaptureAndLatestPartial(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, otherBrowser, voice := newVoiceEventStreamEnv(t)
	q := store.New(env.pool)
	ctx := t.Context()
	baseline := readVoiceEvents(t, env, alice, voice.ID, "")
	streamURL := env.server.URL + "/v0/voice-sessions/" + voice.ID + "/events/stream?after=" + url.QueryEscape(baseline.NextCursor)
	response := openSSE(t, alice, streamURL, 20*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	nextSSEEvent(t, reader, "voice.ready")
	// This write bypasses the App's broker. Live delivery must use PostgreSQL NOTIFY.
	_, err := q.UpdateVoiceSessionPartialTranscript(ctx, store.UpdateVoiceSessionPartialTranscriptParams{ID: voice.ID, LatestPartialText: textForVoiceTest("The latest long sentence"), LatestPartialStartOffsetMs: pgtype.Int8{Int64: 10, Valid: true}, LatestPartialEndOffsetMs: pgtype.Int8{Int64: 100, Valid: true}})
	if err != nil {
		t.Fatal(err)
	}
	partial := nextSSEEvent(t, reader, "voice.partial")
	var hypothesis httpapi.VoiceTranscriptEventPage
	decode(t, []byte(partial.Data), &hypothesis)
	if partial.ID != "" || hypothesis.PartialTranscript == nil || *hypothesis.PartialTranscript != "The latest long sentence" {
		t.Fatalf("partial=%+v", partial)
	}
	capture, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "voice_stream_capture", AccountID: "account_alice", RoomID: voice.RoomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	_, err = q.CreateVoiceTranscriptSegment(ctx, store.CreateVoiceTranscriptSegmentParams{ID: "voice_stream_speech", EventID: "voice_stream_speech", VoiceSessionID: voice.ID, CaptureSessionID: textForVoiceTest(capture.ID), Lane: "live", StartOffsetMs: 100, EndOffsetMs: 200, Text: "A confirmed sentence", NormalizedText: "Aconfirmedsentence", Kind: "speech", AccountID: "account_alice", RoomID: voice.RoomID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET status='finalizing',updated_at=clock_timestamp() WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	seenSpeech, seenStop := false, false
	cursor := baseline.NextCursor
	for !seenSpeech || !seenStop {
		record := nextSSEEvent(t, reader, "voice.events")
		var page httpapi.VoiceEventPage
		decode(t, []byte(record.Data), &page)
		if page.NextCursor != record.ID {
			t.Fatal("event ID differs from the page cursor")
		}
		cursor = page.NextCursor
		for _, item := range page.Items {
			if item.Transcript != nil && item.Transcript.EventId == "voice_stream_speech" && item.Transcript.Kind == httpapi.Speech {
				seenSpeech = true
			}
			if item.Capture != nil && item.Capture.Status == "finalizing" {
				seenStop = true
			}
		}
	}
	if page := readVoiceEvents(t, env, alice, voice.ID, cursor); len(voiceEventTranscripts(page)) != 0 {
		t.Fatalf("SSE cursor did not catch up: %+v", page)
	}
	for _, path := range []string{"/events", "/events/stream"} {
		status, _, _ := env.request(otherBrowser, http.MethodGet, "/v0/voice-sessions/"+voice.ID+path, nil, "")
		if status != http.StatusNotFound {
			t.Fatalf("foreign voice access=%d", status)
		}
	}
	status, _, _ := env.request(alice, http.MethodGet, "/v0/voice-sessions/"+voice.ID+"/events?after=other:1", nil, "")
	if status != http.StatusBadRequest {
		t.Fatalf("foreign cursor accepted=%d", status)
	}
	if _, err = env.pool.Exec(ctx, "DELETE FROM room_members WHERE room_id=$1 AND actor_id=$2", voice.RoomID, voice.CreatedByActorID); err != nil {
		t.Fatal(err)
	}
	nextSSEEvent(t, reader, "access.revoked")
}

func TestVoiceEventFeedResumesFromTheTranscriptSnapshot(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, otherBrowser, voice := newVoiceEventStreamEnv(t)
	ctx := t.Context()
	q := store.New(env.pool)
	segment := func(sessionID, id string, start int64) {
		t.Helper()
		if _, err := q.CreateVoiceTranscriptSegment(ctx, store.CreateVoiceTranscriptSegmentParams{ID: id, EventID: id, VoiceSessionID: sessionID, Lane: "live", StartOffsetMs: start, EndOffsetMs: start + 50, Text: id, NormalizedText: id, Kind: "speech"}); err != nil {
			t.Fatal(err)
		}
	}
	segment(voice.ID, "before_snapshot", 100)
	// The bootstrap page and its event cursor come from one snapshot: the feed
	// after that cursor holds exactly what was committed later.
	status, _, body := env.request(alice, http.MethodGet, "/v0/voice-sessions/"+voice.ID+"/transcript-events", nil, "")
	var bootstrap httpapi.VoiceTranscriptEventPage
	decode(t, body, &bootstrap)
	if status != http.StatusOK || bootstrap.EventCursor == nil || len(bootstrap.Items) != 1 || bootstrap.Items[0].EventId != "before_snapshot" {
		t.Fatalf("bootstrap=%d %s", status, body)
	}
	segment(voice.ID, "after_snapshot", 200)
	if got := voiceEventTranscripts(readVoiceEvents(t, env, alice, voice.ID, *bootstrap.EventCursor)); len(got) != 1 || got[0] != "after_snapshot" {
		t.Fatalf("feed after the snapshot=%v", got)
	}

	// Concurrent locked writers on two sessions: each feed returns every
	// segment once, in seq order.
	otherRoom := env.createRoom(otherBrowser, acmeTenant, "Voice events other", "voice-events-other")
	other, err := q.CreateVoiceSession(ctx, store.CreateVoiceSessionParams{ID: "voice_events_other", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: otherRoom, ProviderRoomName: "voice-events-other", ParticipantIdentity: "voice-events-other", Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	var writers sync.WaitGroup
	for index := range 20 {
		for _, sessionID := range []string{voice.ID, other.ID} {
			writers.Go(func() {
				id := fmt.Sprintf("%s_concurrent_%02d", sessionID, index)
				tx, beginErr := env.pool.Begin(ctx)
				if beginErr != nil {
					t.Error(beginErr)
					return
				}
				defer tx.Rollback(ctx)
				if writeErr := writeLockedVoiceSegment(ctx, tx, sessionID, id, int64(1000+index*100)); writeErr != nil {
					t.Error(writeErr)
					return
				}
				if commitErr := tx.Commit(ctx); commitErr != nil {
					t.Error(commitErr)
				}
			})
		}
	}
	writers.Wait()
	var seqs []int64
	if err = env.pool.QueryRow(ctx, "SELECT array_agg(seq ORDER BY seq) FROM voice_transcript_segments WHERE voice_session_id=$1", voice.ID).Scan(&seqs); err != nil || len(seqs) != 22 {
		t.Fatalf("seqs=%v err=%v", seqs, err)
	}
	// An identical retry keeps its seq; a speaker fill-in takes a new one so
	// the feed resends the row.
	retry := func(speaker string) int64 {
		t.Helper()
		row, retryErr := q.CreateVoiceTranscriptSegment(ctx, store.CreateVoiceTranscriptSegmentParams{ID: "after_snapshot", EventID: "after_snapshot", VoiceSessionID: voice.ID, Lane: "live", StartOffsetMs: 200, EndOffsetMs: 250, Text: "after_snapshot", NormalizedText: "after_snapshot", Kind: "speech", SpeakerID: pgtype.Text{String: speaker, Valid: speaker != ""}})
		if retryErr != nil {
			t.Fatal(retryErr)
		}
		return row.Seq
	}
	if unchanged := retry(""); unchanged != seqs[1] {
		t.Fatalf("identical retry moved seq %d -> %d", seqs[1], unchanged)
	}
	if filled := retry("spk_1"); filled <= seqs[len(seqs)-1] {
		t.Fatalf("speaker fill-in kept an old seq %d", filled)
	}

	// A notification lost by the listener reaches the stream at the next heartbeat.
	cursor := readVoiceEvents(t, env, alice, voice.ID, *bootstrap.EventCursor)
	for cursor.HasMore {
		cursor = readVoiceEvents(t, env, alice, voice.ID, cursor.NextCursor)
	}
	response := openSSE(t, alice, env.server.URL+"/v0/voice-sessions/"+voice.ID+"/events/stream?after="+url.QueryEscape(cursor.NextCursor), 20*time.Second)
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	nextSSEEvent(t, reader, "voice.ready")
	// updated_at alone sends no notification, but the session snapshot
	// carries it, so the next heartbeat delivers the change.
	if _, err := env.pool.Exec(ctx, "UPDATE voice_sessions SET updated_at=clock_timestamp()+interval '1 second' WHERE id=$1", voice.ID); err != nil {
		t.Fatal(err)
	}
	record := nextSSEEvent(t, reader, "voice.events")
	var recovered httpapi.VoiceEventPage
	decode(t, []byte(record.Data), &recovered)
	if len(recovered.Items) != 1 || recovered.Items[0].Session == nil {
		t.Fatalf("heartbeat recovery=%+v", recovered)
	}
	// Signing out ends the stream at the next heartbeat.
	if status, _, _ := env.request(alice, http.MethodPost, "/v0/auth/logout", nil, ""); status != http.StatusNoContent {
		t.Fatalf("logout=%d", status)
	}
	nextSSEEvent(t, reader, "session.expired")
}
