package integration_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestMcpPresentationSequenceTracksDeliveredReply(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("durable reply provenance after terminal and rollback", sequenceReplyProvenanceSurvivesTerminalAndRollback)
	// This test owns every delivery step, including the cancel-before-delivery window.
	env, alice := newTaskWorkerEnv(t, skipping(app.PresentationLoop))
	ctx := t.Context()
	roomID := createPrivateRoom(t, env, alice, "Sequence reply", "sequence-reply-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	if _, err := env.pool.Exec(ctx, `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	messageID := createAgentMentionRequest(t, env.pool, roomID, "actor_acme_alice")
	issued, err := agentcredential.New(env.pool).IssueManaged(ctx, acmeOfficialAgentManagementID, "presentation CLI")
	if err != nil {
		t.Fatal(err)
	}
	token := issued.AccessToken
	contexts := agentauth.New(env.pool)
	payload := map[string]any{
		"invocation_id": mcpFileInvocationID("sequence-reply"), "inbox_id": "room:" + roomID,
		"source_message_id": messageID,
		"messages":          []map[string]string{{"content": "First reply", "pause_before": "none"}, {"content": "Second reply", "pause_before": "natural"}},
	}
	const endpoint = "/api/agent/v1/presentation-sequences"
	const messageCommit = "/api/agent/v1/messages/commit"
	// postReply admits a reply through the sequence endpoint or commits one
	// ordinary Agent message.
	postReply := func(requestPath string, input map[string]any) (int, []byte) {
		t.Helper()
		if requestPath == messageCommit {
			return commitAgentMessage(t, env, token, "room", roomID, input)
		}
		return postAgentInRoom(t, env, token, roomID, requestPath, input)
	}
	code, body := postAgentInRoom(t, env, token, roomID, endpoint, payload)
	if code != http.StatusOK {
		t.Fatalf("publish sequence: %d %s", code, body)
	}
	var result struct {
		SequenceID       string `json:"sequence_id"`
		DuplicateRequest bool   `json:"duplicate_request"`
		Reason           string `json:"reason"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if result.DuplicateRequest {
		t.Fatalf("first sequence was reported as a duplicate: %s", body)
	}
	originalSequenceID := result.SequenceID
	// Acceptance may precede the due clock. Drive only an undelivered first item.
	deliverFirst := func(sequenceID string) {
		t.Helper()
		if countRows(t, env, `SELECT count(*) FROM agent_presentation_sequence_items WHERE sequence_id=$1 AND position=1 AND delivered_at IS NULL`, sequenceID) == 0 {
			return
		}
		if _, err := env.pool.Exec(ctx, `UPDATE agent_presentation_sequence_items SET not_before=clock_timestamp()-interval '1 second' WHERE sequence_id=$1 AND position=1`, sequenceID); err != nil {
			t.Fatal(err)
		}
		if n, err := agentsendmessage.NewPresentationSequenceService(env.pool).RunOnce(ctx, 1); err != nil || n != 1 {
			t.Fatalf("first delivery: %d %v", n, err)
		}
	}
	deliverFirst(result.SequenceID)
	// The worker sleeps until the second bubble's natural pause has passed.
	if wait, err := store.New(env.pool).NextAgentPresentationSequenceItemWaitMilliseconds(ctx); err != nil || wait <= 0 || wait > 1500 {
		t.Fatalf("next due wait after the first bubble: %d %v", wait, err)
	}
	var firstMessageID string
	if err := env.pool.QueryRow(ctx, `SELECT delivered_message_id FROM agent_presentation_sequence_items WHERE sequence_id=$1 AND position=1`, result.SequenceID).Scan(&firstMessageID); err != nil {
		t.Fatal(err)
	}
	code, _, visibleReply := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+firstMessageID, nil, "")
	var reply struct {
		ReplyToMessageID string `json:"reply_to_message_id"`
	}
	decode(t, visibleReply, &reply)
	if code != http.StatusOK || reply.ReplyToMessageID != messageID {
		t.Fatalf("sequence bubble must identify its input without completing a Draft: %d %s", code, visibleReply)
	}
	if countRows(t, env, `SELECT cardinality(mentioned_actor_ids) FROM messages WHERE id=$1`, firstMessageID) != 0 || countRows(t, env, `SELECT count(*) FROM rooms WHERE parent_room_id=$1`, roomID) != 0 {
		t.Fatal("sequence reply must not create a Thread or automatic Mention")
	}
	code, replay := postAgentInRoom(t, env, token, roomID, endpoint, payload)
	var replayed struct {
		SequenceID       string `json:"sequence_id"`
		DuplicateRequest bool   `json:"duplicate_request"`
		Reason           string `json:"reason"`
	}
	decode(t, replay, &replayed)
	if code != http.StatusOK || replayed.SequenceID != result.SequenceID || !replayed.DuplicateRequest || replayed.Reason == "" {
		t.Fatalf("replay: %d %s", code, replay)
	}
	if n := countRows(t, env, `SELECT count(*) FROM agent_presentation_sequence_items WHERE sequence_id=$1 AND delivered_at IS NOT NULL`, result.SequenceID); n != 1 {
		t.Fatalf("replay delivered %d items, want first item only", n)
	}
	changed := cloneRoutineMap(payload)
	changed["messages"] = []map[string]string{{"content": "Conflicting reply", "pause_before": "none"}, {"content": "Second reply", "pause_before": "natural"}}
	code, body = postAgentInRoom(t, env, token, roomID, endpoint, changed)
	if code != http.StatusConflict {
		t.Fatalf("same operation with changed payload accepted: %d %s", code, body)
	}
	otherRoomID := createPrivateRoom(t, env, alice, "Unjoined room", "sequence-unjoined-room")
	code, body = postAgentInRoom(t, env, token, otherRoomID, endpoint, payload)
	if code != http.StatusForbidden {
		t.Fatalf("unjoined Room accepted: %d %s", code, body)
	}
	// A newer request must not inherit bubbles authored before it arrived.
	laterMessageID := createAgentMentionRequest(t, env.pool, roomID, "actor_acme_alice")
	// Admission alone is not delivery; cancellation must not manufacture a reply.
	service := agentsendmessage.NewPresentationSequenceService(env.pool)
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	authority, err := contexts.AuthorizeInTx(agentauth.WithTarget(ctx, "room", roomID), tx, token, "send_message_sequence")
	if err != nil {
		t.Fatal(err)
	}
	queued, err := service.CreateAuthorizedInTx(ctx, tx, agentsendmessage.AuthorizedPresentationSequenceInput{
		RoomID: roomID, TenantID: authority.TenantID, AgentActorID: authority.AgentActorID,
		AgentManagementID: authority.AgentID, SourceMessageID: laterMessageID,
		IdempotencyKey: "sequence-canceled-before-delivery", Items: []agentsendmessage.PresentationItem{{Content: "Never delivered", PauseBefore: agentsendmessage.PresentationPauseNone}, {Content: "Also canceled", PauseBefore: agentsendmessage.PresentationPauseNone}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := store.New(env.pool).CancelAgentPresentationSequence(ctx, queued.SequenceID); err != nil {
		t.Fatal(err)
	}
	makeDue := func(sequenceID string) {
		t.Helper()
		if _, err := env.pool.Exec(ctx, `UPDATE agent_presentation_sequence_items SET not_before=clock_timestamp()-interval '3 seconds',delivered_at=CASE WHEN delivered_at IS NULL THEN NULL ELSE clock_timestamp()-interval '3 seconds' END WHERE sequence_id=$1`, sequenceID); err != nil {
			t.Fatal(err)
		}
	}
	makeDue(originalSequenceID)
	if n, err := service.RunOnce(ctx, 10); err != nil || n != 1 {
		t.Fatalf("delayed original bubble: %d %v", n, err)
	}
	payload["invocation_id"] = mcpFileInvocationID("sequence-after-steer")
	payload["source_message_id"] = laterMessageID
	code, body = postAgentInRoom(t, env, token, roomID, endpoint, payload)
	if code != http.StatusOK {
		t.Fatalf("new reply after request: %d %s", code, body)
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	deliverFirst(result.SequenceID)
	makeDue(result.SequenceID)
	// A replacement worker can finish admitted delivery without any Runtime or Run.
	if n, err := agentsendmessage.NewPresentationSequenceService(env.pool).RunOnce(ctx, 10); err != nil || n != 1 {
		t.Fatalf("replacement worker delivery: %d %v", n, err)
	}
	if count := countRows(t, env, `SELECT count(*) FROM agent_presentation_sequence_items WHERE sequence_id=$1 AND delivered_message_id IS NOT NULL`, queued.SequenceID); count != 0 {
		t.Fatalf("canceled sequence delivered %d items", count)
	}
	if count := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official'`, roomID); count != 4 {
		t.Fatalf("two complete sequences must publish exactly four messages, got %d", count)
	}
	// Human Messages queue Runs; the Agent's presented replies queue none.
	if count := countRows(t, env, `SELECT count(DISTINCT input.local_run_id) FROM agent_runtime_inputs input
		JOIN messages message ON message.id=input.source_message_id
		WHERE message.author_actor_id='actor_acme_official' AND input.local_run_id IS NOT NULL`); count != 0 {
		t.Fatalf("ordinary presentation created %d Runs", count)
	}
	t.Run("source identity is checked before admission and replay", func(t *testing.T) {
		before := countRows(t, env, `SELECT count(*) FROM agent_presentation_sequences WHERE room_id=$1`, roomID)
		otherMessageID := createHumanMessage(t, env, alice, otherRoomID, "other Room source", "sequence-other-room-source")
		privateMessageID := "sequence_private_input"
		if _, err := env.pool.Exec(ctx, `INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind) VALUES($1,'tenant_acme',$2,'actor_acme_alice','private','[{"type":"text","content":"private"}]','agent_runtime')`, privateMessageID, roomID); err != nil {
			t.Fatal(err)
		}
		for _, source := range []string{otherMessageID, privateMessageID, "missing_message"} {
			invalid := cloneRoutineMap(payload)
			invalid["invocation_id"] = mcpFileInvocationID("invalid-source-" + source)
			invalid["source_message_id"] = source
			requests := map[string]map[string]any{endpoint: invalid, messageCommit: {"invocation_id": invalid["invocation_id"], "inbox_id": "room:" + roomID, "source_message_id": source, "segments": []map[string]any{{"type": "text", "content": "invisible source reply"}}}}
			for requestPath, request := range requests {
				code, body := postReply(requestPath, request)
				var failure struct{ Error struct{ Code string } }
				decode(t, body, &failure)
				if code != http.StatusForbidden || failure.Error.Code != "forbidden" {
					t.Fatalf("invisible source must have uniform visibility error: endpoint=%s status=%d body=%s", requestPath, code, body)
				}
			}
		}
		if err := messagecreation.ValidateAgentReplySource(ctx, store.New(env.pool), "other_tenant", roomID, "actor_acme_official", messageID); !errors.Is(err, messagecreation.ErrInvalidReference) {
			t.Fatalf("cross-tenant source validation: %v", err)
		}
		changedSource := cloneRoutineMap(payload)
		changedSource["source_message_id"] = messageID
		code, body := postAgentInRoom(t, env, token, roomID, endpoint, changedSource)
		if code != http.StatusConflict {
			t.Fatalf("same operation rebound source: %d %s", code, body)
		}
		if got := countRows(t, env, `SELECT count(*) FROM agent_presentation_sequences WHERE room_id=$1`, roomID); got != before {
			t.Fatalf("invalid source leaked sequences: %d -> %d", before, got)
		}
		if err := revokeAgentCredential(ctx, env.pool, issued.CredentialID); err != nil {
			t.Fatal(err)
		}
		rotated, err := agentcredential.New(env.pool).IssueManaged(ctx, issued.AgentID, "rotated sequence CLI")
		if err != nil {
			t.Fatal(err)
		}
		token = rotated.AccessToken
		code, body = postAgentInRoom(t, env, token, roomID, endpoint, payload)
		if code != http.StatusOK {
			t.Fatalf("credential rotation changed durable receipt: %d %s", code, body)
		}
	})
	t.Run("single message source uses the same business authority", func(t *testing.T) {
		input := map[string]any{"invocation_id": mcpFileInvocationID("single-source"), "inbox_id": "room:" + roomID, "source_message_id": messageID, "segments": []map[string]any{{"type": "text", "content": "one reply"}}}
		code, first := postReply(messageCommit, input)
		if code != http.StatusOK {
			t.Fatalf("single source reply: %d %s", code, first)
		}
		var created struct {
			MessageID string `json:"message_id"`
		}
		decode(t, first, &created)
		if n := countRows(t, env, `SELECT count(*) FROM messages WHERE id=$1 AND reply_to_message_id=$2`, created.MessageID, messageID); n != 1 {
			t.Fatalf("single reply provenance=%d", n)
		}
		code, replay := postReply(messageCommit, input)
		if code != http.StatusOK || !agentMessageReplayMatches(t, first, replay) {
			t.Fatalf("single replay: %d %s", code, replay)
		}
		// Canceling the source Message for its Agent and ending its queued Run
		// must not change the reply receipt.
		if _, err := env.pool.Exec(ctx, `INSERT INTO room_agent_message_cancellations(tenant_id,room_id,agent_actor_id,message_id)
			VALUES('tenant_acme',$1,'actor_acme_official',$2)`, roomID, messageID); err != nil {
			t.Fatal(err)
		}
		endQueuedRunsOfMessage(t, env, messageID)
		// During logical Room deletion, reply provenance must still independently
		// protect its source. Roll back this probe before testing receipt replay.
		deleting, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer deleting.Rollback(ctx)
		if _, err := deleting.Exec(ctx, `UPDATE rooms SET deletion_started_at=clock_timestamp(),deletion_started_by_actor_id='actor_acme_alice' WHERE id=$1`, roomID); err != nil {
			t.Fatal(err)
		}
		// Sequence admission has an independent source FK. Isolate committed
		// reply provenance only within this rolled-back probe.
		clearedSequences, err := deleting.Exec(ctx, `UPDATE agent_presentation_sequences SET reply_to_message_id=NULL WHERE room_id=$1 AND reply_to_message_id=$2`, roomID, messageID)
		if err != nil {
			t.Fatal(err)
		}
		if clearedSequences.RowsAffected() == 0 {
			t.Fatal("delete probe had no independent Sequence source reference")
		}
		if _, err := deleting.Exec(ctx, `DELETE FROM messages WHERE id=$1`, messageID); err == nil {
			t.Fatal("persisted reply source was deleted during Room deletion")
		} else {
			var constraint *pgconn.PgError
			if !errors.As(err, &constraint) || constraint.Code != "23503" || constraint.ConstraintName != "messages_reply_to_fk" {
				t.Fatalf("expected source foreign key protection, got %v", err)
			}
		}
		if err := deleting.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		if restored := countRows(t, env, `SELECT count(*) FROM agent_presentation_sequences WHERE room_id=$1 AND reply_to_message_id=$2`, roomID, messageID); int64(restored) != clearedSequences.RowsAffected() {
			t.Fatalf("rolled-back probe changed Sequence source references: restored=%d original=%d", restored, clearedSequences.RowsAffected())
		}
		code, replay = postReply(messageCommit, input)
		if code != http.StatusOK || !agentMessageReplayMatches(t, first, replay) {
			t.Fatalf("source execution cancellation changed receipt: %d %s", code, replay)
		}
		input["source_message_id"] = laterMessageID
		code, body := postReply(messageCommit, input)
		if code != http.StatusConflict {
			t.Fatalf("single source rebind: %d %s", code, body)
		}
	})
	t.Run("durable receipts survive source visibility changes while new admissions fail closed", func(t *testing.T) {
		for index, requestPath := range []string{endpoint, messageCommit} {
			source := createHumanMessage(t, env, alice, roomID, "source before visibility changed", fmt.Sprintf("source-visibility-%d", index))
			input := map[string]any{"invocation_id": mcpFileInvocationID("visibility-" + requestPath), "inbox_id": "room:" + roomID, "source_message_id": source}
			if requestPath == endpoint {
				input["messages"] = payload["messages"]
			} else {
				input["segments"] = []map[string]any{{"type": "text", "content": "durable reply"}}
			}
			code, first := postReply(requestPath, input)
			if code != http.StatusOK {
				t.Fatalf("admit reply: %d %s", code, first)
			}
			// Hidden Runtime inputs are only visible to their targeted Agent. The
			// receipt still proves the reply was committed while the source was visible.
			if _, err := env.pool.Exec(ctx, `UPDATE messages SET message_kind='agent_runtime' WHERE id=$1`, source); err != nil {
				t.Fatal(err)
			}
			code, replay := postReply(requestPath, input)
			if requestPath == endpoint {
				var original, duplicate struct {
					SequenceID       string `json:"sequence_id"`
					DuplicateRequest bool   `json:"duplicate_request"`
					Reason           string `json:"reason"`
				}
				decode(t, first, &original)
				decode(t, replay, &duplicate)
				if code != http.StatusOK || duplicate.SequenceID != original.SequenceID || !duplicate.DuplicateRequest || duplicate.Reason == "" {
					t.Fatalf("invisible source broke committed sequence receipt: %d %s", code, replay)
				}
			} else if code != http.StatusOK || !agentMessageReplayMatches(t, first, replay) {
				t.Fatalf("invisible source broke committed receipt: %d %s", code, replay)
			}
			changed := cloneRoutineMap(input)
			changed["source_message_id"] = "missing_message"
			if code, body := postReply(requestPath, changed); code != http.StatusConflict {
				t.Fatalf("changed source replayed receipt: %d %s", code, body)
			}
			input["invocation_id"] = mcpFileInvocationID("new-invisible-" + requestPath)
			code, body := postReply(requestPath, input)
			var failure struct {
				Error struct{ Code, Message string }
			}
			decode(t, body, &failure)
			if code != http.StatusForbidden || failure.Error.Code != "forbidden" || !strings.Contains(failure.Error.Message, "Reply source") {
				t.Fatalf("new invisible source must fail with actionable source error: %d %s", code, body)
			}
		}
	})
	if code, _, body := env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "sequence-reply-delete-room"); code != http.StatusNoContent {
		t.Fatalf("reply provenance must not block logical Room deletion: %d %s", code, body)
	}
	if countRows(t, env, `SELECT count(*) FROM messages reply JOIN agent_presentation_sequence_items item ON item.delivered_message_id=reply.id WHERE reply.room_id=$1 AND reply.reply_to_message_id=$2`, roomID, messageID) != 2 {
		t.Fatal("logical Room deletion must preserve both admitted bubble replies")
	}
}

func sequenceReplyProvenanceSurvivesTerminalAndRollback(t *testing.T) {
	env := newRuntimeStateTestEnv(t)
	ctx := t.Context()
	if _, err := env.pool.Exec(ctx, `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	inputMessageID := createAgentMentionRequest(t, env.pool, testRuntimeInboxRoom, "actor_acme_alice")
	submitted := acceptPresentationInboxMessage(t, env, testRuntimeInboxRoom, inputMessageID)
	if _, err := env.service.ClaimLocalRun(ctx, agentruntimestate.ClaimLocalRunInput{ClaimID: "sequence-provenance-claim", ContextKey: env.contextKey, Epoch: env.epoch}); err != nil {
		t.Fatal(err)
	}
	// Agent Service opens the claimed Run's status before the Provider starts.
	if _, err := env.service.OpenRuntimeStatus(ctx, agentruntimestate.OpenStatusInput{ContextKey: env.contextKey, Epoch: env.epoch,
		LocalRunID: submitted.RunID, InitialSourceIDs: []string{"room:" + testRuntimeInboxRoom},
	}); err != nil {
		t.Fatal(err)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(ctx, testRuntimeAgentID, "durable sequence CLI")
	if err != nil {
		t.Fatal(err)
	}
	// A reply by a different Agent cannot acknowledge this Agent's obligation.
	if _, err := env.pool.Exec(ctx, `INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES('actor_sequence_other','tenant_acme','agent','Other Agent','sequence-other')`); err != nil {
		t.Fatal(err)
	}
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	q := store.New(tx)
	other, err := q.GetActor(ctx, store.GetActorParams{ID: "actor_sequence_other", TenantID: "tenant_acme"})
	if err != nil {
		t.Fatal(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: "another Agent's reply"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = messagecreation.Create(ctx, q, messagecreation.Draft{
		TenantID: "tenant_acme", RoomID: testRuntimeInboxRoom, Author: other, Content: content, ReplyToMessageID: inputMessageID,
	}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	service := agentsendmessage.NewPresentationSequenceService(env.pool)
	// runClaim is the Run the CLI names in its Run header.
	admitRun := func(key, sourceMessageID, runClaim string) (agentsendmessage.PresentationSequenceResult, error) {
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			return agentsendmessage.PresentationSequenceResult{}, err
		}
		defer tx.Rollback(ctx)
		authority, err := agentauth.New(env.pool).AuthorizeInTx(agentauth.WithTarget(ctx, "room", testRuntimeInboxRoom), tx, issued.AccessToken, "send_message_sequence")
		if err != nil {
			return agentsendmessage.PresentationSequenceResult{}, err
		}
		result, err := service.CreateAuthorizedInTx(messagecreation.WithRunClaim(ctx, runClaim), tx, agentsendmessage.AuthorizedPresentationSequenceInput{
			RoomID: testRuntimeInboxRoom, TenantID: authority.TenantID, AgentActorID: authority.AgentActorID, AgentManagementID: authority.AgentID,
			SourceMessageID: sourceMessageID, IdempotencyKey: key,
			Items: []agentsendmessage.PresentationItem{{Content: "first", PauseBefore: agentsendmessage.PresentationPauseNone}, {Content: "second", PauseBefore: agentsendmessage.PresentationPauseNone}},
		})
		if err != nil {
			return agentsendmessage.PresentationSequenceResult{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return agentsendmessage.PresentationSequenceResult{}, err
		}
		_, err = env.pool.Exec(ctx, `UPDATE agent_presentation_sequence_items SET not_before=clock_timestamp()+interval '1 hour' WHERE sequence_id=$1 AND delivered_at IS NULL`, result.SequenceID)
		return result, err
	}
	admit := func(key, sourceMessageID, runClaim string) agentsendmessage.PresentationSequenceResult {
		t.Helper()
		result, err := admitRun(key, sourceMessageID, runClaim)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	// The Run the CLI names is the only provenance a sequence can carry.
	sequence := admit("sequence-provenance-known", inputMessageID, submitted.RunID)
	// A current Run never supplies missing or ambiguous CLI business provenance.
	missing := admit("sequence-provenance-missing-source", "", "")
	// A Run-linked sequence without a reply source still answers only through its Run.
	legacy := admit("sequence-provenance-legacy", "", submitted.RunID)
	// The Run is not part of the operation: a replay naming no Run returns the
	// admitted sequence, which keeps its Run.
	if replay := admit("sequence-provenance-known", inputMessageID, ""); !replay.Replay || replay.SequenceID != sequence.SequenceID {
		t.Fatalf("replay without the Run drifted: %+v", replay)
	}
	if row, err := store.New(env.pool).GetAgentPresentationSequence(ctx, sequence.SequenceID); err != nil || row.LocalRunID.String != submitted.RunID {
		t.Fatalf("admitted sequence Run: %+v %v", row, err)
	}
	// A Run that is not this Agent's running Run here is ignored, not stored.
	unowned := admit("sequence-provenance-unowned-run", "", "run_not_owned_by_agent")
	if row, err := store.New(env.pool).GetAgentPresentationSequence(ctx, unowned.SequenceID); err != nil || row.LocalRunID.Valid {
		t.Fatalf("unowned Run ref persisted provenance: %+v %v", row, err)
	}
	insertRuntimeStatusMessageFixture(t, env.pool, testRuntimeInboxRoom, "sequence_later_input", "later question")
	ambiguous := admit("sequence-provenance-multiple-inputs", "", "")
	send := newAgentSendService(t, env.pool, agentauth.New(env.pool))
	otherReply := agentSendInput("room:"+testRuntimeInboxRoom, mcpFileInvocationID("other-reply-source"),
		agentsendmessage.PreparedSegment{Type: "text", Content: "reply to another input"})
	otherReply.SourceMessageID = "sequence_later_input"
	if _, err := send.Send(agentauth.WithTarget(ctx, "room", testRuntimeInboxRoom), issued.AccessToken, otherReply); err != nil {
		t.Fatal(err)
	}
	// The same exact-source rule applies to single CLI messages with a bound input.
	singleMessageID := createAgentMentionRequest(t, env.pool, testRuntimeInboxRoom, "actor_acme_alice")
	singleInput := runtimeInput("sequence-single-source", "internal", "", "single reply")
	singleInput.SourceMessageID = singleMessageID
	if _, err := env.service.AcceptTrustedNotification(ctx, agentruntimestate.AcceptTrustedNotificationInput{ContextKey: env.contextKey, Epoch: env.epoch, ExecutionRunRef: submitted.RunID, Input: singleInput}); err != nil {
		t.Fatal(err)
	}
	singleReply := agentSendInput("room:"+testRuntimeInboxRoom, mcpFileInvocationID("bound-single-reply"),
		agentsendmessage.PreparedSegment{Type: "text", Content: "exact single reply"})
	singleReply.SourceMessageID = singleMessageID
	if _, err := send.Send(agentauth.WithTarget(ctx, "room", testRuntimeInboxRoom), issued.AccessToken, singleReply); err != nil {
		t.Fatal(err)
	}
	if replay := admit("sequence-provenance-known", inputMessageID, submitted.RunID); !replay.Replay || replay.SequenceID != sequence.SequenceID {
		t.Fatalf("replay changed the admitted sequence: %+v", replay)
	}
	if replay := admit("sequence-provenance-legacy", "", submitted.RunID); !replay.Replay || replay.SequenceID != legacy.SequenceID {
		t.Fatalf("legacy receipt replay drifted: %+v", replay)
	}
	if _, err = env.service.FinishLocalRun(ctx, agentruntimestate.FinishLocalRunInput{ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID,
		Terminal: json.RawMessage(`{"type":"succeeded"}`),
	}); err != nil {
		t.Fatal(err)
	}
	before, err := store.New(env.pool).GetAgentRunStatus(ctx, submitted.RunID)
	if err != nil || before.Status != "succeeded" {
		t.Fatalf("finish Run before any bubble: %+v %v", before, err)
	}
	if _, err = env.pool.Exec(ctx, `UPDATE agent_presentation_sequence_items SET not_before=clock_timestamp()-interval '1 second' WHERE sequence_id=$1`, sequence.SequenceID); err != nil {
		t.Fatal(err)
	}
	// Fail after Message, reply and Room Event writes to exercise their real rollback.
	if _, err = env.pool.Exec(ctx, `CREATE FUNCTION fail_sequence_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delivery failed'; END $$;
CREATE TRIGGER fail_sequence_delivery BEFORE UPDATE OF delivered_message_id ON agent_presentation_sequence_items FOR EACH ROW EXECUTE FUNCTION fail_sequence_delivery()`); err != nil {
		t.Fatal(err)
	}
	if _, err = service.RunOnce(ctx, 1); err == nil {
		t.Fatal("expected delivery transaction to fail")
	}
	var leaked int
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE room_id=$1 AND body IN ('first','second')`, testRuntimeInboxRoom).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("rolled-back messages leaked: %d %v", leaked, err)
	}
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM room_events WHERE room_id=$1 AND event_type='message.created' AND payload->'message'->>'raw_message' IN ('first','second')`, testRuntimeInboxRoom).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("rolled-back message events leaked: %d %v", leaked, err)
	}
	if _, err = env.pool.Exec(ctx, `DROP TRIGGER fail_sequence_delivery ON agent_presentation_sequence_items; DROP FUNCTION fail_sequence_delivery()`); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []struct{ id, replyTo string }{{sequence.SequenceID, inputMessageID}, {legacy.SequenceID, ""}, {missing.SequenceID, ""}, {ambiguous.SequenceID, ""}} {
		if _, err = env.pool.Exec(ctx, `UPDATE agent_presentation_sequence_items SET not_before=clock_timestamp()-interval '1 second' WHERE sequence_id=$1`, expected.id); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			// Replacing the worker recovers only the durable admitted snapshot.
			if n, err := agentsendmessage.NewPresentationSequenceService(env.pool).RunOnce(ctx, 1); err != nil || n != 1 {
				t.Fatalf("recover admitted delivery: %d %v", n, err)
			}
		}
		var count int
		if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM agent_presentation_sequence_items item
JOIN messages message ON message.id=item.delivered_message_id
JOIN room_events event ON event.resource_id=message.id AND event.event_type='message.created'
WHERE item.sequence_id=$1 AND message.room_id=$2 AND message.author_actor_id='actor_acme_official'
AND COALESCE(message.reply_to_message_id,'')=$3 AND COALESCE(event.payload->'message'->>'reply_to_message_id','')=$3`, expected.id, testRuntimeInboxRoom, expected.replyTo).Scan(&count); err != nil || count != 2 {
			t.Fatalf("durable reply facts for %s: %d %v", expected.id, count, err)
		}
	}
	if n, err := service.RunOnce(ctx, 10); err != nil || n != 0 {
		t.Fatalf("repeated delivery manufactured extra messages: %d %v", n, err)
	}
	after, err := store.New(env.pool).GetAgentRunStatus(ctx, submitted.RunID)
	if err != nil || after.Status != "succeeded" || after.EventOrdinal != before.EventOrdinal {
		t.Fatalf("asynchronous bubbles reopened or advanced a terminal Run log: %+v %v", after, err)
	}
}

// endQueuedRunsOfMessage cancels the queued Runs holding messageID.
func endQueuedRunsOfMessage(t *testing.T, env *testEnv, messageID string) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	rows, err := tx.Query(t.Context(), `SELECT DISTINCT run.run_id FROM agent_local_runs run
		JOIN agent_runtime_inputs input ON input.local_run_id=run.run_id
		WHERE input.source_message_id=$1 AND run.status='queued' ORDER BY run.run_id`, messageID)
	if err != nil {
		t.Fatal(err)
	}
	runIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := agentruntimestate.TerminateLocalRuns(t.Context(), store.New(tx), runIDs, json.RawMessage(`{"type":"canceled"}`)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
