package integration_test

import (
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

type workRoomResponse struct {
	ID        string `json:"id"`
	TenantID  string `json:"tenant_id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	CreatedBy struct {
		ID string `json:"id"`
	} `json:"created_by"`
}

// cardMessageResponse is a Message with its hydrated Typed Card.
type cardMessageResponse struct {
	ID   string `json:"id"`
	Card struct {
		CardType   string `json:"card_type"`
		Intent     string `json:"intent"`
		Version    int64  `json:"version"`
		DecisionID string `json:"decision_id"`
	} `json:"card"`
}

func createLinkedWorkItem(t *testing.T, env *testEnv, client *http.Client, suffix, originRoomID string) workItemResponse {
	t.Helper()
	payload := map[string]any{"kind": "issue", "title": "Linked issue " + suffix}
	if originRoomID != "" {
		payload["origin_room_id"] = originRoomID
	}
	status, _, body := env.request(client, http.MethodPost, "/v0/tenants/"+acmeTenant+"/work-items", payload, "linked-item-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create linked Work Item status=%d body=%s", status, body)
	}
	var item workItemResponse
	decode(t, body, &item)
	return item
}

// createWorkRoomFixture creates a private Room with the given members and links
// it as workItemID's Work Room, as Task approval does for a managed Task.
func createWorkRoomFixture(t *testing.T, env *testEnv, owner *http.Client, workItemID, name string, memberActorIDs ...string) string {
	t.Helper()
	roomID := createPrivateRoom(t, env, owner, name, "work-room-fixture-"+workItemID)
	for _, actorID := range memberActorIDs {
		if status, body := putRoomMember(t, env, owner, roomID, actorID, "member"); status != http.StatusOK {
			t.Fatalf("add Work Room member %s status=%d body=%s", actorID, status, body)
		}
	}
	createTaskWorkRoomLink(t, env, workItemID, roomID)
	return roomID
}

// roomCreationApprovalInput is the official Agent's pending create_room
// request in originRoomID; key keeps its submission distinct.
func roomCreationApprovalInput(t *testing.T, originRoomID, key string) typedcard.CreationApprovalInTxInput {
	t.Helper()
	proposal := typedcard.RoomCreationSnapshot{OriginRoomID: originRoomID, Name: "Acceptance file release",
		MemberIDs:              []string{"actor_acme_alice", "actor_acme_official"},
		InitialMessageSegments: []messagecreation.Segment{{Type: "text", Content: "Review after generating the report"}},
	}
	encoded, err := json.Marshal(proposal)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(encoded)
	return typedcard.CreationApprovalInTxInput{
		RoomID: originRoomID, AgentManagementID: acmeOfficialAgentManagementID, IdempotencyOperation: "test-room-creation:" + key, CallerInputHash: hash[:],
		Submission: typedcard.CreationApprovalSubmission{SubmissionID: "room-creation-" + key, CallerInput: encoded, EffectivePayload: encoded, FulfillmentSnapshot: encoded},
	}
}

// createPendingRoomCreationApproval submits the official Agent's create_room
// request in originRoomID and returns its pending creation approval.
func createPendingRoomCreationApproval(t *testing.T, env *testEnv, originRoomID, suffix string) string {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	created, err := typedcard.New(env.pool).CreateCreationApprovalRequestInTx(t.Context(), tx, roomCreationApprovalInput(t, originRoomID, suffix))
	if err != nil {
		t.Fatalf("request Room creation: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return created.DecisionID
}

// denyRoomCreationApproval denies a pending creation approval as decider.
func denyRoomCreationApproval(t *testing.T, env *testEnv, decider *http.Client, requestID, suffix string) {
	t.Helper()
	status, _, body := env.request(decider, http.MethodPost, "/v0/decisions/"+requestID,
		map[string]any{"decision": "deny", "expected_version": 1, "comment": "Not now."}, "room-creation-deny-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("deny Room creation status=%d body=%s", status, body)
	}
}

// createFixtureDelegatedTask has the official Agent delegate a Task from
// originRoomID, sponsored by Alice, and returns the Task and its
// Work Room.
func createFixtureDelegatedTask(t *testing.T, env *testEnv, originRoomID, suffix string) (string, string) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	agent, err := queries.GetActor(t.Context(), store.GetActorParams{ID: "actor_acme_official", TenantID: acmeTenant})
	if err != nil {
		t.Fatal(err)
	}
	sponsor, err := queries.GetActor(t.Context(), store.GetActorParams{ID: "actor_acme_alice", TenantID: acmeTenant})
	if err != nil {
		t.Fatal(err)
	}
	created, err := typedcard.CreateDelegatedTaskInTx(t.Context(), tx, queries, typedcard.DelegatedTaskInput{
		TenantID: acmeTenant, OriginRoomID: originRoomID, Agent: agent,
		AgentManagementID: acmeOfficialAgentManagementID, Sponsor: sponsor,
		Name: "Acceptance file release " + suffix, Requirement: "Review after generating the report", SourceKey: "test-delegated-task:" + suffix,
	})
	if err != nil {
		t.Fatalf("delegate Task: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return created.TaskID, created.WorkRoomID
}

func getGuardWorkItemResponse(t *testing.T, env *testEnv, client *http.Client, workItemID string) workItemResponse {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/work-items/"+workItemID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("get Work Item status=%d body=%s", status, body)
	}
	var item workItemResponse
	decode(t, body, &item)
	return item
}
