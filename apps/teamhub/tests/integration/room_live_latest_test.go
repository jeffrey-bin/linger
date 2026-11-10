package integration_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestRoomLiveLatestNotificationAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRunEnv(t, "http://127.0.0.1:1")
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	insertRuntimeRegistrationFixture(t, env.pool, "live-observer", "active")
	roomID := createPrivateRoom(t, env, alice, "Live latest notification", "live-latest-room")
	for _, actorID := range []string{"actor_acme_official", "actor-live-observer"} {
		if status, body := putRoomMember(t, env, alice, roomID, actorID, "member"); status != 200 {
			t.Fatalf("member: %d %s", status, body)
		}
	}
	ordinaryID := createHumanMessage(t, env, alice, roomID, "Ordinary update", "live-latest-message")
	// Create the targeted internal receipt with its final kind and message.created
	// coordinate in one production transaction.
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	author, err := queries.GetActor(t.Context(), store.GetActorParams{ID: "actor_acme_alice", TenantID: acmeTenant})
	if err != nil {
		t.Fatal(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{
		{Type: "text", Content: "Target receipt secret"},
		{Type: "reference", Content: "@Agent", Target: "actor_acme_official", TargetType: "agent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := messagecreation.Create(t.Context(), queries, messagecreation.Draft{
		TenantID: acmeTenant, RoomID: roomID, Author: author, Content: content, Kind: "agent_runtime",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	receiptID := receipt.Message.ID
	runtime := agentruntimestate.New(env.pool)
	refs := map[string]agentruntimestate.Context{}
	for _, agentID := range []string{acmeOfficialAgentManagementID, "live-observer"} {
		ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: agentID, RoomID: roomID}, TargetResidency: "active"})
		if err != nil {
			t.Fatal(err)
		}
		refs[agentID] = ensured.Context
	}
	startRuntimeEpoch(t, runtime, "live-latest-test")
	// The Contexts were created after both Messages; apply them as their
	// transactions would have.
	deliver := func() {
		t.Helper()
		requeueCommittedRoomMessage(t, env.pool, ordinaryID)
		requeueCommittedRoomMessage(t, env.pool, receiptID)
	}
	observer := "live-observer"
	inputs := func(agentID string) []string {
		t.Helper()
		rows, err := env.pool.Query(t.Context(), `SELECT payload::text FROM agent_runtime_inputs WHERE context_key=$1 ORDER BY input_sequence`, refs[agentID].ContextKey)
		if err != nil {
			t.Fatal(err)
		}
		payloads, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatal(err)
		}
		return payloads
	}
	// A General observer under direct mentions receives neither Message.
	deliver()
	if got := inputs(observer); len(got) != 0 {
		t.Fatalf("observer inputs=%v, want none", got)
	}
	// Explicitly configure the same non-target Agent as AnotherMe; ordinary
	// Messages reach it while the targeted receipt stays denied. The fixture
	// Agent is already Alice's one AnotherMe, so the observer represents a
	// peer Human.
	seedPeerHumanActor(t, env.pool)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_bob' WHERE agent_management_id=$1`, observer); err != nil {
		t.Fatal(err)
	}
	deliver()
	observed := inputs(observer)
	if len(observed) != 1 || strings.Contains(observed[0], "Target receipt secret") || !strings.Contains(observed[0], "Ordinary update") {
		t.Fatalf("observer payloads=%v", observed)
	}
	if target := inputs(acmeOfficialAgentManagementID); len(target) != 2 || !strings.Contains(target[1], receiptID) {
		t.Fatalf("target payloads=%v", target)
	}
	// The observer's only work is the ordinary Message; the denied receipt added none.
	observedRun, err := runtime.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-observer", ContextKey: refs[observer].ContextKey, Epoch: "live-latest-test"})
	if err != nil || observedRun.Run == nil || len(observedRun.Run.Inputs) != 1 {
		t.Fatalf("non-target receipt became queued work: %+v %v", observedRun, err)
	}
	claimed, err := runtime.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-live-run", ContextKey: refs[acmeOfficialAgentManagementID].ContextKey, Epoch: "live-latest-test"})
	if err != nil || claimed.Run == nil {
		t.Fatalf("claim=%+v %v", claimed, err)
	}
	credentials := agentcredential.New(env.pool)
	issued, err := credentials.IssueManaged(t.Context(), acmeOfficialAgentManagementID, "room-live-test")
	if err != nil {
		t.Fatal(err)
	}
	business := agentauth.New(env.pool)
	scopeCtx := agentauth.WithTarget(t.Context(), "room", roomID)
	assertAuthority := func() {
		t.Helper()
		authority, err := business.Authorize(scopeCtx, issued.AccessToken, "list_routines")
		if err != nil || authority.RoomID != roomID || authority.AgentType != "anotherme" {
			t.Fatalf("independent Room authority=%+v %v", authority, err)
		}
	}
	assertAuthority()
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_local_runs SET status='succeeded',terminal='{"status":"succeeded"}'::jsonb,finished_at=clock_timestamp() WHERE run_id=$1`, claimed.Run.RunID); err != nil {
		t.Fatal(err)
	}
	// Runtime completion does not revoke an Agent's current business permissions.
	assertAuthority()
	if err := revokeAgentCredential(t.Context(), env.pool, issued.CredentialID); err != nil {
		t.Fatalf("expire credential: %v", err)
	}
	if _, err := business.Authorize(scopeCtx, issued.AccessToken, "list_routines"); !errors.Is(err, agentauth.ErrCredentialInvalid) {
		t.Fatalf("revoked credential retained Room authority: %v", err)
	}
}

// The request refers to an old MR summary, although the newest topic is AWS.
// Quoted messages are part of this input, not additional Inbox deliveries.
func TestRoomNotificationExplicitContextSurvivesDelivery(t *testing.T) {
	allowParallelIntegrationTest(t)
	// Share application/identities; each delivery owns its Room, documents,
	// receipts, Context and projection directory. No scenario resets another.
	env, alice := newAgentRunEnv(t, "http://127.0.0.1:1")
	for _, dispatch := range []string{"queued"} {
		t.Run(dispatch, func(t *testing.T) {
			roomID := createPrivateRoom(t, env, alice, "Reference regression "+dispatch, "reference-room-"+dispatch)
			if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != 200 {
				t.Fatalf("member: %d %s", code, body)
			}
			quotedBody := "| MR | Result |\n| !991 | Merged |"
			quoteID := createHumanMessage(t, env, alice, roomID, quotedBody, "reference-mr-"+dispatch)
			secondID := createHumanMessage(t, env, alice, roomID, "Addendum: 63 MRs in total", "reference-second-"+dispatch)
			createHumanMessage(t, env, alice, roomID, "AWS AnotherMe model check", "reference-aws-"+dispatch)

			var documents [2]struct {
				ID             string `json:"id"`
				CurrentVersion struct {
					ID string `json:"id"`
				} `json:"current_version"`
			}
			for index := range documents {
				code, _, body := requestUnifiedDocumentUpload(t, env, alice, fmt.Sprintf("reference-document-%s-%d", dispatch, index), map[string]string{"filename": "report.txt", "representation_format": "plain_text", "media_type": "text/plain"}, "report.txt", []byte(fmt.Sprintf("private document body %d", index)))
				if code != 201 {
					t.Fatalf("upload: %d %s", code, body)
				}
				decode(t, body, &documents[index])
			}
			code, _, body := env.request(alice, "POST", "/v0/rooms/"+roomID+"/messages", map[string]any{
				"raw_message": "@Official please write a document to record report.txt report.txt",
				"segments": []map[string]any{
					{"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"},
					{"type": "text", "content": " please write a document to record "},
					{"type": "document", "content": "report.txt", "document_id": documents[0].ID},
					{"type": "text", "content": " "},
					{"type": "file", "content": "report.txt", "document_id": documents[1].ID, "document_version_id": documents[1].CurrentVersion.ID},
				}, "context_message_ids": []string{secondID, quoteID},
			}, "reference-request-"+dispatch)
			if code != 201 {
				t.Fatalf("create: %d %s", code, body)
			}
			var request struct {
				ID string `json:"id"`
			}
			decode(t, body, &request)
			// General receives this actual mention, while the earlier ordinary
			// discussion stays filtered.
			history := readAgentHistoryMessage(t, env, "actor_acme_official", request.ID)
			if history.MessageID != request.ID || len(history.ContextMessages) != 2 || history.ContextMessages[0].MessageID != secondID || history.ContextMessages[1].MessageID != quoteID || !strings.Contains(history.ContextMessages[1].Body, "!991") {
				t.Fatalf("direct history lost exact quoted context: %+v", history)
			}

			runtime := agentruntimestate.New(env.pool)
			ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: roomID}, TargetResidency: "active"})
			if err != nil {
				t.Fatal(err)
			}
			startRuntimeEpoch(t, runtime, "reference-test-")
			fence := "reference-test-"
			// The Context was created after the decision; apply the Message as
			// the decision's transaction would have.
			requeueCommittedRoomMessage(t, env.pool, request.ID)
			queued := queuedRuntimeInbox(t, env.pool, ensured.Context.ContextKey, request.ID)
			assertContexts := func(raw []byte) {
				t.Helper()
				var data struct {
					Notification struct {
						Messages []struct {
							ID        string   `json:"id"`
							Contexts  []string `json:"contextMessageIds"`
							Resources []struct {
								Type       string `json:"type"`
								DocumentID string `json:"document_id"`
								VersionID  string `json:"document_version_id"`
							} `json:"resourceReferences"`
						} `json:"messages"`
					} `json:"acceptedNotification"`
				}
				if err := json.Unmarshal(raw, &data); err != nil {
					t.Fatal(err)
				}
				m := data.Notification.Messages
				if len(m) != 1 || m[0].ID != request.ID || strings.Join(m[0].Contexts, ",") != secondID+","+quoteID || strings.Contains(string(raw), "!991") {
					t.Fatalf("explicit stable references lost or body copied: %s", raw)
				}
				r := m[0].Resources
				if len(r) != 2 || r[0].Type != "document" || r[0].DocumentID != documents[0].ID || r[1].Type != "file" || r[1].DocumentID != documents[1].ID || r[1].VersionID != documents[1].CurrentVersion.ID || strings.Contains(string(raw), "forged-document") || strings.Contains(string(raw), `"path":`) || strings.Contains(string(raw), "private document body") {
					t.Fatalf("resource identity lost, forged, or expanded: %s", raw)
				}
			}
			var storedPayload []byte
			if err := env.pool.QueryRow(t.Context(), `SELECT payload FROM agent_runtime_inputs WHERE context_key=$1 AND input_id=$2`, ensured.Context.ContextKey, queued.InputID).Scan(&storedPayload); err != nil {
				t.Fatal(err)
			}
			assertContexts(storedPayload)
			run, err := runtime.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-reference-" + dispatch, ContextKey: ensured.Context.ContextKey, Epoch: fence})
			if err != nil || run.Run == nil || len(run.Run.Inputs) != 1 {
				t.Fatalf("claim: %+v %v", run, err)
			}
			assertContexts(run.Run.Inputs[0].Payload)
		})
	}
}
