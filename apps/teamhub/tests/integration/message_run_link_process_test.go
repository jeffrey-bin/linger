//go:build integration_process

package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type messageRunHistory struct{ *recordingAgentManagement }

func (m *messageRunHistory) ReadRuntimeHistory(_ context.Context, _ roomagent.RuntimeContextTarget, _ roomagent.RuntimeHistoryReadOptions) (roomagent.RuntimeHistory, error) {
	return roomagent.RuntimeHistory{Status: "available", ProviderKind: "codex", Records: []roomagent.RuntimeHistoryRecord{
		{Ordinal: 1, TurnID: "this-turn", Category: "reasoning", NativeType: "response_item.reasoning", NativeRecord: map[string]any{"type": "reasoning"}},
		{Ordinal: 2, TurnID: "this-turn", ToolCallID: "call_cli", Category: "tool_call", NativeType: "response_item.function_call", NativeRecord: map[string]any{"type": "function_call"}},
		{Ordinal: 3, TurnID: "other-turn", ToolCallID: "other_call", Category: "tool_call", NativeType: "response_item.function_call", NativeRecord: map[string]any{"type": "function_call"}},
	}}, nil
}

// Only native provider History is deterministic. Configuration loading, CLI
// process, multipart HTTP, authorization, transactions and Human reads are real.
func TestMessageSendRunLinkCrossProcess(t *testing.T) {
	buildTeamHubCLIForProcess(t)
	for _, routine := range []bool{false, true} {
		name := "ordinary"
		if routine {
			name = "routine"
		}
		t.Run(name, func(t *testing.T) {
			env, alice, credential, roomID := newAgentCLIIdentity(t, withAgentManagement(&messageRunHistory{&recordingAgentManagement{}}))
			var sourceID string
			if routine {
				code, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/routines", map[string]any{
					"name": "Standup", "instruction": "Report progress", "mention_actor_id": "actor_acme_official",
					"cadence": map[string]any{"kind": "every_n_hours", "timezone": "UTC", "interval_hours": 1},
				}, "message-link-routine")
				if code != http.StatusCreated {
					t.Fatalf("create Routine: %d %s", code, body)
				}
				var created reminder.Reminder
				decode(t, body, &created)
				sourceID = fireReminderOccurrence(t, env, created.ID).MessageID
			} else {
				env.createMessage(alice, roomID, "Please reply", "message-link-source")
				if err := env.pool.QueryRow(t.Context(), `SELECT id FROM messages WHERE room_id=$1 AND body='Please reply'`, roomID).Scan(&sourceID); err != nil {
					t.Fatal(err)
				}
			}
			runtime := agentruntimestate.New(env.pool)
			ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: roomID}, TargetResidency: "active"})
			if err != nil {
				t.Fatal(err)
			}
			startRuntimeEpoch(t, runtime, "message-link")
			fence := "message-link"
			var submitted agentruntimestate.SubmitTrustedTurnResult
			if routine {
				// The Routine label follows the queued Inbox input that names the fired instruction.
				requeueCommittedRoomMessage(t, env.pool, sourceID)
				submitted.RunID = queuedRuntimeInbox(t, env.pool, ensured.Context.ContextKey, sourceID).RunID
				if submitted.RunID == "" {
					t.Fatal("fired Routine queued no Run")
				}
			} else {
				input := runtimeInput("input", "trusted_turn", "room:"+roomID, "Reply")
				input.SourceMessageID = sourceID
				if submitted, err = runtime.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: ensured.Context.ContextKey, Epoch: fence, Inputs: []agentruntimestate.RuntimeInput{input}}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := runtime.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "message-link-claim", ContextKey: ensured.Context.ContextKey, Epoch: fence}); err != nil {
				t.Fatal(err)
			}
			if _, err := runtime.OpenRuntimeStatus(t.Context(), agentruntimestate.OpenStatusInput{ContextKey: ensured.Context.ContextKey, Epoch: fence, LocalRunID: submitted.RunID, InitialSourceIDs: []string{"room:" + roomID}}); err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256([]byte("call_cli"))
			event, _ := json.Marshal(map[string]any{"type": "activity.started", "activity_id": "native-" + hex.EncodeToString(digest[:]), "kind": "command", "title": "Running a command"})
			if _, err := runtime.OfferRuntimePresentationEvents(t.Context(), agentruntimestate.OfferPresentationEventsInput{LocalRunID: submitted.RunID, Events: []agentruntimestate.OfferedPresentationEvent{{CommandID: "message-link-activity", Event: event}}}); err != nil {
				t.Fatal(err)
			}
			directory := t.TempDir()
			configFile := filepath.Join(directory, "config.json")
			if err := os.WriteFile(filepath.Join(directory, "credential"), []byte(credential.AccessToken), 0600); err != nil {
				t.Fatal(err)
			}
			targetRoom := roomID
			send := func(runID, operation string, flags ...string) string {
				t.Helper()
				profile := map[string]any{"url": env.server.URL, "token_file": "credential", "scope": map[string]string{"kind": "room", "id": targetRoom}}
				configBytes, _ := json.Marshal(map[string]any{"version": 1, "default_profile": "runtime", "profiles": map[string]any{"runtime": profile}})
				if err := os.WriteFile(configFile, configBytes, 0600); err != nil {
					t.Fatal(err)
				}
				// Per-run fields live in run.json beside the config, as the Computer writes them.
				run := map[string]any{}
				if runID != "" {
					run["run_id"] = runID
				}
				runBytes, _ := json.Marshal(run)
				if err := os.WriteFile(filepath.Join(directory, "run.json"), runBytes, 0600); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
				defer cancel()
				command := exec.CommandContext(ctx, "node", append([]string{repositoryPath("apps", "teamhub-cli", "dist", "teamhub.js"), "message", "send", "--content", "CLI reply " + operation, "--json"}, flags...)...)
				command.Dir = directory
				command.Env = []string{"PATH=" + os.Getenv("PATH"), "TEAMHUB_CONFIG=" + configFile, "TEAMHUB_STATE_ROOT=" + t.TempDir()}
				output, err := command.CombinedOutput()
				if err != nil {
					t.Fatalf("teamhub message send: %v %s", err, output)
				}
				var result struct {
					MessageID string `json:"message_id"`
					Accepted  bool   `json:"accepted"`
				}
				decode(t, output, &result)
				if !result.Accepted || result.MessageID == "" {
					t.Fatalf("CLI receipt: %s", output)
				}
				return result.MessageID
			}
			messageID := send(submitted.RunID, "reply")
			var invocationID, outputInvocationID string
			if err := env.pool.QueryRow(t.Context(), `SELECT invocation_id FROM command_replays WHERE resource_id=$1 AND invocation_id IS NOT NULL`, messageID).Scan(&invocationID); err != nil {
				t.Fatal(err)
			}
			if err := env.pool.QueryRow(t.Context(), `SELECT invocation_id FROM agent_runtime_status_events WHERE message_id=$1 AND event_type='presentation.output_created'`, messageID).Scan(&outputInvocationID); err != nil || outputInvocationID != invocationID {
				t.Fatalf("output invocation=%q want=%q err=%v", outputInvocationID, invocationID, err)
			}
			output := agentruntimestate.PresentationOutput{LocalRunID: submitted.RunID, TenantID: "tenant_acme", RoomID: roomID, AgentActorID: "actor_acme_official", InvocationID: invocationID, OutputID: messageID, OutputKind: "message", Surface: "room_timeline", MessageID: messageID}
			replay := recordRuntimePresentationOutput(t, env.pool, output)
			if replay.Recorded {
				t.Fatal("output retry created a duplicate event")
			}
			output.InvocationID = "agent-invocation-sha256:" + strings.Repeat("f", 64)
			tx, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			_, conflict := agentruntimestate.RecordPresentationOutput(t.Context(), store.New(tx), output)
			_ = tx.Rollback(t.Context())
			if !errors.Is(conflict, agentruntimestate.ErrPresentationConflict) {
				t.Fatalf("output retry changed invocation: %v", conflict)
			}
			verifyContinuingMessageOutput(t, env, credential.AccessToken, roomID, submitted.RunID, messageID, send(submitted.RunID, "acknowledgement", "--continuing"))
			// A valid Agent credential still cannot attach another Room's run.
			targetRoom = createPrivateRoom(t, env, alice, "Other Room", "message-link-other-room")
			if code, body := putRoomMember(t, env, alice, targetRoom, "actor_acme_official", "member"); code != http.StatusOK {
				t.Fatalf("other membership: %d %s", code, body)
			}
			unrelated := send(submitted.RunID, "other-room")
			if countRows(t, env, `SELECT count(*) FROM agent_runtime_status_events WHERE message_id=$1`, unrelated) != 0 {
				t.Fatal("cross-Room message linked to unrelated run")
			}
			targetRoom = roomID
			if _, err := runtime.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{ContextKey: ensured.Context.ContextKey, Epoch: fence, RunID: submitted.RunID, Terminal: json.RawMessage(`{"type":"succeeded"}`)}); err != nil {
				t.Fatal(err)
			}
			linked, err := store.New(env.pool).GetAgentRunStatusForMessage(t.Context(), store.GetAgentRunStatusForMessageParams{MessageID: messageID, RoomID: roomID})
			if err != nil || linked.RunID != submitted.RunID {
				t.Fatalf("run link=%s err=%v", linked.RunID, err)
			}
			code, _, body := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+messageID+"/activities", nil, "")
			var activities struct {
				Status        string `json:"status"`
				HasNativeTurn bool   `json:"has_native_turn"`
				Records       []struct {
					TurnID string `json:"turn_id"`
				} `json:"records"`
			}
			decode(t, body, &activities)
			if code != 200 || activities.Status != "available" || !activities.HasNativeTurn || len(activities.Records) != 2 {
				t.Fatalf("activity log: %d %s", code, body)
			}
			for _, record := range activities.Records {
				if record.TurnID != "this-turn" {
					t.Fatalf("unrelated turn leaked: %s", body)
				}
			}
			code, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+messageID, nil, "")
			if code != 200 || strings.Contains(string(body), `"routine_name":"Standup"`) != routine {
				t.Fatalf("Routine label: %d %s", code, body)
			}
			independent := send("", "independent")
			if _, err := store.New(env.pool).GetAgentRunStatusForMessage(t.Context(), store.GetAgentRunStatusForMessageParams{MessageID: independent, RoomID: roomID}); err == nil {
				t.Fatal("independent message acquired a run")
			}
			if countRows(t, env, `SELECT count(*) FROM agent_runtime_status_events WHERE local_run_id=$1 AND message_id=$2`, submitted.RunID, messageID) != 1 {
				t.Fatal("message has multiple output links")
			}
		})
	}
}

// --continuing reaches output_created through the real CLI and commit endpoint;
// the declaration is part of both the send receipt and the output identity.
func verifyContinuingMessageOutput(t *testing.T, env *testEnv, token, roomID, runID, finalID, continuingID string) {
	t.Helper()
	declared := func(messageID string) (present bool, value string) {
		if err := env.pool.QueryRow(t.Context(), `SELECT payload ? 'continues', coalesce(payload->>'continues','') FROM agent_runtime_status_events WHERE local_run_id=$1 AND message_id=$2 AND event_type='presentation.output_created'`, runID, messageID).Scan(&present, &value); err != nil {
			t.Fatal(err)
		}
		return
	}
	if present, value := declared(continuingID); !present || value != "true" {
		t.Fatalf("continuing output declaration present=%v value=%q", present, value)
	}
	if present, _ := declared(finalID); present {
		t.Fatal("undeclared output gained a continuation field")
	}
	var invocationID string
	if err := env.pool.QueryRow(t.Context(), `SELECT invocation_id FROM command_replays WHERE resource_id=$1 AND invocation_id IS NOT NULL`, continuingID).Scan(&invocationID); err != nil {
		t.Fatal(err)
	}
	output := agentruntimestate.PresentationOutput{LocalRunID: runID, TenantID: "tenant_acme", RoomID: roomID, AgentActorID: "actor_acme_official", InvocationID: invocationID, OutputID: continuingID, OutputKind: "message", Surface: "room_timeline", MessageID: continuingID, Continues: true}
	if replay := recordRuntimePresentationOutput(t, env.pool, output); replay.Recorded {
		t.Fatal("continuing output retry created a duplicate event")
	}
	output.Continues = false
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	_, conflict := agentruntimestate.RecordPresentationOutput(t.Context(), store.New(tx), output)
	_ = tx.Rollback(t.Context())
	if !errors.Is(conflict, agentruntimestate.ErrPresentationConflict) {
		t.Fatalf("output retry dropped its continuation declaration: %v", conflict)
	}
	commit := func(continues bool) (int, map[string]any) {
		metadata := map[string]any{"invocation_id": invocationID, "inbox_id": "room:" + roomID, "segments": []map[string]any{{"type": "text", "content": "CLI reply acknowledgement"}}, "uploads": []any{}}
		if continues {
			metadata["continues"] = true
		}
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		part, err := writer.CreateFormField("metadata")
		if err != nil {
			t.Fatal(err)
		}
		if err := json.NewEncoder(part).Encode(metadata); err != nil {
			t.Fatal(err)
		}
		_ = writer.Close()
		request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/api/agent/v1/messages/commit", &buffer)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", writer.FormDataContentType())
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-Teamhub-Context-Kind", "room")
		request.Header.Set("X-Teamhub-Context-Id", roomID)
		request.Header.Set("X-Teamhub-Run-Id", runID)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(response.Body).Decode(&body)
		return response.StatusCode, body
	}
	if code, body := commit(true); code != http.StatusOK || body["duplicate_request"] != true || body["message_id"] != continuingID {
		t.Fatalf("identical continuing replay: %d %v", code, body)
	}
	if code, body := commit(false); code != http.StatusConflict {
		t.Fatalf("same invocation without the declaration: %d %v", code, body)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_runtime_status_events WHERE local_run_id=$1 AND message_id=$2`, runID, continuingID) != 1 {
		t.Fatal("continuing message has multiple output links")
	}
}
