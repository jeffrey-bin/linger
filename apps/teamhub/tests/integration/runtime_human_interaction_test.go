package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestRuntimeHumanInteractionCardReplyAndExpiry(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRunEnv(t, "http://127.0.0.1:1")
	insertRuntimeRoomMembership(t, env.pool, "runtime-question-room")
	service := agentruntimestate.New(env.pool)
	ensured, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: testRuntimeAgentID, RoomID: "runtime-question-room"}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	startRuntimeEpoch(t, service, "question-instance")
	fence := "question-instance"
	key := ensured.Context.ContextKey
	submitted, err := service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: key, Epoch: fence, Inputs: []agentruntimestate.RuntimeInput{runtimeInput("question-input", "trusted_turn", "", "Question")}})
	if err != nil {
		t.Fatal(err)
	}
	if runClaim, err := service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-question", ContextKey: key, Epoch: fence}); err != nil || runClaim.Run == nil {
		t.Fatalf("claim Run=%+v error=%v", runClaim, err)
	}
	questions := map[string]any{"type": "questions", "questions": []any{map[string]any{"id": "q", "prompt": "Choose", "input": "radio", "options": []any{map[string]any{"id": "o1", "label": "Yes"}}}}}
	// The Runtime asks questions only; a confirm card always comes from a
	// permission review or a Connector confirmation.
	for name, request := range map[string]map[string]any{
		"retired approval kind":  {"request_id": "retired-approval", "kind": "approval", "prompt": "Approve?", "form": map[string]any{"type": "confirm"}},
		"retired async question": {"request_id": "retired-async", "kind": "async_question", "prompt": "Choose", "form": questions},
		"confirm question":       {"request_id": "confirm-question", "kind": "native_question", "prompt": "Approve?", "form": map[string]any{"type": "confirm"}},
		"form as encoded JSON":   {"request_id": "string-form", "kind": "native_question", "prompt": "Choose", "form": `{"type":"questions"}`},
		"radio without options":  {"request_id": "radio-without-options", "kind": "native_question", "prompt": "Choose", "form": map[string]any{"type": "questions", "questions": []any{map[string]any{"id": "q", "prompt": "Pick", "input": "radio"}}}},
		"assignee outside Room":  {"request_id": "outside-assignee", "kind": "native_question", "prompt": "Choose", "assignee_actor_id": "actor-outside-room", "form": questions},
	} {
		input := map[string]any{"context_key": key, "execution_run_ref": submitted.RunID, "operation_id": "question-operation", "request": request}
		status, body := agentRuntimeStateRequest(t, env.server.Config.Handler, http.MethodPost, "/v0/agent-runtime/human-interactions", teamHubInternalToken, input)
		if status != http.StatusBadRequest {
			t.Fatalf("%s accepted: status=%d body=%s", name, status, body)
		}
		if request["assignee_actor_id"] != nil && !bytes.Contains(body, []byte("assignee_actor_id must name a human member of this Room")) {
			t.Fatalf("%s did not name the assignee: %s", name, body)
		}
	}
	create := func(id, kind string) (string, string) {
		t.Helper()
		input := map[string]any{"context_key": key, "execution_run_ref": submitted.RunID, "operation_id": "question-operation", "request": map[string]any{"request_id": id, "kind": kind, "prompt": "Disposable database question", "form": questions}}
		status, body := agentRuntimeStateRequest(t, env.server.Config.Handler, http.MethodPost, "/v0/agent-runtime/human-interactions", teamHubInternalToken, input)
		if status != http.StatusCreated {
			t.Fatalf("create %s: status=%d body=%s", kind, status, body)
		}
		var result struct {
			InteractionID string `json:"interaction_id"`
			MessageID     string `json:"message_id"`
		}
		decode(t, body, &result)
		status, replay := agentRuntimeStateRequest(t, env.server.Config.Handler, http.MethodPost, "/v0/agent-runtime/human-interactions", teamHubInternalToken, input)
		if status != http.StatusCreated || !bytes.Equal(body, replay) {
			t.Fatalf("replay=%d %s", status, replay)
		}
		input["request"].(map[string]any)["prompt"] = "Changed content"
		status, body = agentRuntimeStateRequest(t, env.server.Config.Handler, http.MethodPost, "/v0/agent-runtime/human-interactions", teamHubInternalToken, input)
		if status != http.StatusConflict {
			t.Fatalf("changed identity accepted: %d %s", status, body)
		}
		return result.InteractionID, result.MessageID
	}
	interaction, messageID := create("native-question", "native_question")
	status, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+interaction, map[string]any{"expected_version": 1, "decision": "submit", "answers": map[string]any{"q": "now"}}, "question-decision")
	if status != http.StatusOK {
		t.Fatalf("decision=%d %s", status, body)
	}
	var hiddenID string
	if err := env.pool.QueryRow(t.Context(), `SELECT id FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, messageID).Scan(&hiddenID); err != nil {
		t.Fatal(err)
	}
	assertHumanVisibleMessageIDs(t, env, alice, "runtime-question-room", hiddenID, false)
	// The decision's hidden receipt steers the answer into the Run that asked.
	var answer string
	if err := env.pool.QueryRow(t.Context(), `SELECT payload::text FROM agent_runtime_inputs
		WHERE context_key=$1 AND source_message_id=$2 AND status='steering' AND local_run_id=$3
		AND selection_result->>'selected'='runtime_response'`, key, hiddenID, submitted.RunID).Scan(&answer); err != nil {
		t.Fatalf("native answer steer: %v", err)
	}
	if !strings.Contains(answer, `"native-question"`) || !strings.Contains(answer, `"now"`) {
		t.Fatalf("native answer payload=%s", answer)
	}
	expired := func(interactionID, messageID string) {
		t.Helper()
		if countRows(t, env, `SELECT count(*) FROM room_events WHERE event_type='card.changed' AND resource_id=$1`, messageID) == 0 {
			t.Fatal("expiry did not record a card change")
		}
		var got string
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, interactionID).Scan(&got); err != nil || got != "expired" {
			t.Fatalf("native interaction status=%s err=%v", got, err)
		}
	}
	// A Run requeued for a restart loses the native turn that asked.
	requeuedPending, requeuedMessageID := create("pending-requeued", "native_question")
	if err := service.RequeueLocalRun(t.Context(), agentruntimestate.RequeueLocalRunInput{ContextKey: key, Epoch: fence, RunID: submitted.RunID}); err != nil {
		t.Fatal(err)
	}
	expired(requeuedPending, requeuedMessageID)
	if runClaim, err := service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-question-again", ContextKey: key, Epoch: fence}); err != nil || runClaim.Run == nil || runClaim.Run.AttemptCount != 2 {
		t.Fatalf("claim requeued Run=%+v error=%v", runClaim, err)
	}
	nativePending, nativePendingMessageID := create("pending-native", "native_question")
	if _, err := service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: key, Epoch: fence, RunID: submitted.RunID, Terminal: json.RawMessage(`{"type":"succeeded"}`)}); err != nil {
		t.Fatal(err)
	}
	expired(nativePending, nativePendingMessageID)
	status, _, body = env.request(alice, http.MethodPost, "/v0/decisions/"+nativePending, map[string]any{"expected_version": 2, "decision": "submit", "answers": map[string]any{"q": "late"}}, "native-late")
	if status != http.StatusConflict {
		t.Fatalf("late native=%d %s", status, body)
	}
}

func assertHumanVisibleMessageIDs(t *testing.T, env *testEnv, principal *http.Client, roomID, messageID string, wantVisible bool) {
	t.Helper()
	status, _, body := env.request(principal, http.MethodGet, "/v0/rooms/"+roomID+"/messages", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Human Messages status=%d body=%s", status, body)
	}
	var page struct {
		Items []struct {
			ID          string `json:"id"`
			MessageKind string `json:"message_kind"`
		} `json:"items"`
	}
	decode(t, body, &page)
	found := false
	for _, item := range page.Items {
		if item.MessageKind == "agent_runtime" {
			t.Fatalf("Human Message list included agent_runtime %s", item.ID)
		}
		if item.ID == messageID {
			found = true
		}
	}
	if found != wantVisible {
		t.Fatalf("Human Message list visible=%t want=%t id=%s body=%s", found, wantVisible, messageID, body)
	}
}
