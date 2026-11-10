package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

type workItemCommentResponse struct {
	ID         string        `json:"id"`
	TenantID   string        `json:"tenant_id"`
	WorkItemID string        `json:"work_item_id"`
	Author     workItemActor `json:"author"`
	Body       string        `json:"body"`
	Segments   []commentPart `json:"segments"`
	Version    int64         `json:"version"`
	DeletedAt  *time.Time    `json:"deleted_at"`
	CreatedAt  time.Time     `json:"created_at"`
	UpdatedAt  time.Time     `json:"updated_at"`
}

type commentPart struct {
	Type    string `json:"type"`
	Content string `json:"content"`
	ActorID string `json:"actor_id"`
}

func newWorkItemAgentEnv(t *testing.T) (*testEnv, *http.Client) {
	t.Helper()
	env := newWorkItemHTTPEnv(t, config.ForTest(func(c *config.Config) {
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
	}))
	return env, env.login("alice", alicePassword)
}

func TestWorkItemCommentsAndAgentAccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/work-items", map[string]any{
		"kind": "issue", "title": "Comment access " + suffix,
	}, "comment-access-item-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Work Item status=%d body=%s", status, body)
	}
	var item workItemResponse
	decode(t, body, &item)

	commentPayload := map[string]any{
		"body": "Please review @official",
		"segments": []map[string]any{
			{"type": "text", "content": "Please review "},
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		},
	}
	commentKey := "comment-create-" + suffix
	status, _, body = env.request(alice, http.MethodPost, "/v0/work-items/"+item.ID+"/comments", commentPayload, commentKey)
	if status != http.StatusCreated {
		t.Fatalf("create Work Item Comment status=%d body=%s", status, body)
	}
	var comment workItemCommentResponse
	decode(t, body, &comment)
	if comment.ID == "" || comment.WorkItemID != item.ID || comment.Author.ID != "actor_acme_alice" || comment.Body != "Please review @official" || comment.Version != 1 {
		t.Fatalf("unexpected Comment: %+v", comment)
	}
	status, replayHeaders, replayBody := env.request(alice, http.MethodPost, "/v0/work-items/"+item.ID+"/comments", commentPayload, commentKey)
	if status != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
		t.Fatalf("Comment create replay status=%d replay=%q body=%s", status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	status, _, _ = env.request(alice, http.MethodPost, "/v0/work-items/"+item.ID+"/comments", map[string]any{
		"body": "changed", "segments": []map[string]any{{"type": "text", "content": "changed"}},
	}, commentKey)
	if status != http.StatusConflict {
		t.Fatalf("changed Comment replay status=%d want=409", status)
	}

	agentBase := "/v0/agents/" + acmeOfficialAgentManagementID
	status, _, _ = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items/"+item.ID, "", "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("missing Agent service token status=%d want=401", status)
	}
	status, _, _ = agentWorkItemRequest(t, env, http.MethodGet, "/v0/agents/not-the-agent/work-items/"+item.ID, teamHubInternalToken, "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("unbound Agent identity status=%d want=404", status)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items/"+item.ID, teamHubInternalToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("referenced Agent cannot read Work Item status=%d body=%s", status, body)
	}
	if bytes.Contains(body, []byte(`"tenant_id"`)) {
		t.Fatalf("Agent Work Item response exposed Tenant identity: %s", body)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items/"+item.ID+"/comments", teamHubInternalToken, "", nil)
	if status != http.StatusOK || !bytes.Contains(body, []byte(comment.ID)) {
		t.Fatalf("referenced Agent cannot list Comments status=%d body=%s", status, body)
	}

	agentCommentPayload := map[string]any{
		"body":     "Agent is reviewing",
		"segments": []map[string]any{{"type": "text", "content": "Agent is reviewing"}},
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items/"+item.ID+"/comments", teamHubInternalToken, "agent-comment-create-"+suffix, agentCommentPayload)
	if status != http.StatusCreated {
		t.Fatalf("authorized Agent create Comment status=%d body=%s", status, body)
	}
	var agentComment workItemCommentResponse
	decode(t, body, &agentComment)
	if agentComment.Author.ID != "actor_acme_official" || agentComment.Version != 1 {
		t.Fatalf("unexpected Agent Comment: %+v", agentComment)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodPatch, agentBase+"/work-items/"+item.ID+"/comments/"+agentComment.ID, teamHubInternalToken, "agent-comment-update-"+suffix, map[string]any{
		"expected_version": 1,
		"body":             "Agent reviewed",
		"segments":         []map[string]any{{"type": "text", "content": "Agent reviewed"}},
	})
	if status != http.StatusOK {
		t.Fatalf("Agent author update Comment status=%d body=%s", status, body)
	}
	decode(t, body, &agentComment)
	if agentComment.Body != "Agent reviewed" || agentComment.Version != 2 {
		t.Fatalf("unexpected Agent Comment update: %+v", agentComment)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodDelete, agentBase+"/work-items/"+item.ID+"/comments/"+agentComment.ID, teamHubInternalToken, "agent-comment-delete-"+suffix, map[string]any{
		"expected_version": agentComment.Version,
	})
	if status != http.StatusOK {
		t.Fatalf("Agent author delete Comment status=%d body=%s", status, body)
	}
	decode(t, body, &agentComment)
	if agentComment.DeletedAt == nil || agentComment.Body != "" || len(agentComment.Segments) != 0 || agentComment.Version != 3 {
		t.Fatalf("unexpected Agent Comment tombstone: %+v", agentComment)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/work-items/"+item.ID+"/comments?limit=1", nil, "")
	if status != http.StatusOK || !bytes.Contains(body, []byte(`"has_more":true`)) || !bytes.Contains(body, []byte(`"next_cursor"`)) {
		t.Fatalf("Comment cursor page status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/work-items/"+item.ID+"/comments", map[string]any{
		"body": "does not match", "segments": []map[string]any{{"type": "text", "content": "different"}},
	}, "comment-invalid-content-"+suffix)
	if status != http.StatusBadRequest {
		t.Fatalf("mismatched Comment segments status=%d want=400 body=%s", status, body)
	}

	status, _, body = env.request(alice, http.MethodPut, "/v0/work-items/"+item.ID+"/assignments/actor_acme_official", nil, "comment-agent-assign-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("assign Agent status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPut, "/v0/work-items/"+item.ID+"/access-grants/actor_acme_official", nil, "comment-agent-grant-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("grant Agent access status=%d body=%s", status, body)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items/"+item.ID+"/transitions", teamHubInternalToken, "comment-agent-transition-"+suffix, map[string]any{
		"expected_version": item.Version, "state": "in_progress",
	})
	if status != http.StatusOK {
		t.Fatalf("assigned Agent transition status=%d body=%s", status, body)
	}
	var transitioned workItemResponse
	decode(t, body, &transitioned)
	if transitioned.State != "in_progress" || transitioned.Version != item.Version+1 {
		t.Fatalf("unexpected Agent transition: %+v", transitioned)
	}

	status, _, body = env.request(alice, http.MethodPatch, "/v0/work-items/"+item.ID+"/comments/"+comment.ID, map[string]any{
		"expected_version": 1,
		"body":             "Reference removed",
		"segments":         []map[string]any{{"type": "text", "content": "Reference removed"}},
	}, "comment-remove-reference-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("remove Comment reference status=%d body=%s", status, body)
	}
	status, _, _ = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items/"+item.ID, teamHubInternalToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("removing one access reason revoked the union status=%d", status)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/work-items/"+item.ID+"/assignments/actor_acme_official", nil, "comment-agent-unassign-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("unassign Agent status=%d body=%s", status, body)
	}
	status, _, _ = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items/"+item.ID, teamHubInternalToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("explicit grant did not preserve access status=%d", status)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/work-items/"+item.ID+"/access-grants/actor_acme_official", nil, "comment-agent-revoke-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("revoke Agent grant status=%d body=%s", status, body)
	}
	status, _, _ = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items/"+item.ID, teamHubInternalToken, "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("Agent retained access after all reasons were removed status=%d", status)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items", teamHubInternalToken, "", nil)
	if status != http.StatusOK || bytes.Contains(body, []byte(item.ID)) {
		t.Fatalf("Agent list leaked revoked Work Item status=%d body=%s", status, body)
	}

	agentCreateKey := "agent-created-item-" + suffix
	agentCreatePayload := map[string]any{
		"kind": "issue", "title": "Agent-created issue " + suffix,
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items", teamHubInternalToken, agentCreateKey, agentCreatePayload)
	if status != http.StatusCreated {
		t.Fatalf("Agent create Work Item status=%d body=%s", status, body)
	}
	var agentCreated workItemResponse
	decode(t, body, &agentCreated)
	if agentCreated.CreatedBy.ID != "actor_acme_official" || len(agentCreated.Assignees) != 0 {
		t.Fatalf("Agent creator became an assignee: %+v", agentCreated)
	}
	status, replayHeaders, replayBody = agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items", teamHubInternalToken, agentCreateKey, agentCreatePayload)
	if status != http.StatusCreated || replayHeaders.Get("Idempotent-Replay") != "true" || !bytes.Equal(replayBody, body) {
		t.Fatalf("Agent Work Item create replay status=%d replay=%q body=%s", status, replayHeaders.Get("Idempotent-Replay"), replayBody)
	}
	status, _, _ = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items/"+agentCreated.ID, teamHubInternalToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("Agent creator access status=%d want=200", status)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodGet, agentBase+"/work-items", teamHubInternalToken, "", nil)
	if status != http.StatusOK || !bytes.Contains(body, []byte(agentCreated.ID)) {
		t.Fatalf("Agent list omitted creator Work Item status=%d body=%s", status, body)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items/"+agentCreated.ID+"/comments", teamHubInternalToken, "agent-creator-comment-"+suffix, map[string]any{
		"body": "Creator note", "segments": []map[string]any{{"type": "text", "content": "Creator note"}},
	})
	if status != http.StatusCreated {
		t.Fatalf("Agent creator Comment status=%d body=%s", status, body)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, agentBase+"/work-items/"+agentCreated.ID+"/transitions", teamHubInternalToken, "agent-creator-transition-"+suffix, map[string]any{
		"expected_version": 1, "state": "in_progress",
	})
	if status != http.StatusForbidden {
		t.Fatalf("unassigned Agent creator transition status=%d want=403 body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/work-items/"+item.ID+"/comments/"+comment.ID, map[string]any{
		"expected_version": 2,
	}, "comment-delete-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("delete Human Comment status=%d body=%s", status, body)
	}
	decode(t, body, &comment)
	if comment.DeletedAt == nil || comment.Body != "" || len(comment.Segments) != 0 || comment.Version != 3 {
		t.Fatalf("Comment tombstone is invalid: %+v", comment)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/work-items/"+item.ID+"/timeline", nil, "")
	if status != http.StatusOK || !bytes.Contains(body, []byte(`"type":"comment"`)) || !bytes.Contains(body, []byte(`"type":"activity"`)) || !bytes.Contains(body, []byte(`"kind":"comment_deleted"`)) {
		t.Fatalf("Work Item timeline did not merge Comments and activity status=%d body=%s", status, body)
	}
}

func TestAgentCreatesWorkItemForAnotherAgentWhoCanFailIt(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	nodeActorID := "actor_workflow_node_" + suffix
	nodeAgentManagementID := "agent-management-workflow-node-" + suffix
	if _, err := env.pool.Exec(t.Context(), `
		insert into actors(id,tenant_id,kind,display_name,handle)
		values($1,$2,'agent','Workflow Node Agent',$3)`,
		nodeActorID, acmeTenant, "@workflow-node-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		insert into agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) values($1,$2,$3,'active','Execute one Workflow node.','gpt-5','actor_acme_alice','computer_fixture','codex','grant_files')`,
		nodeActorID, acmeTenant, nodeAgentManagementID); err != nil {
		t.Fatal(err)
	}

	roomID := env.createRoom(alice, acmeTenant, "Workflow origin "+suffix, "workflow-origin-room-"+suffix)
	status, _, body := env.request(alice, http.MethodPut,
		"/v0/rooms/"+roomID+"/members/actor_acme_official",
		map[string]any{"role": "member"}, "workflow-owner-room-member-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("add Workflow owner to Origin Room status=%d body=%s", status, body)
	}

	ownerBase := "/v0/agents/" + acmeOfficialAgentManagementID
	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, ownerBase+"/work-items", teamHubInternalToken,
		"workflow-assignment-without-origin-"+suffix, map[string]any{
			"kind":               "issue",
			"title":              "Missing Workflow origin " + suffix,
			"assignee_actor_ids": []string{nodeActorID},
		})
	if status != http.StatusBadRequest {
		t.Fatalf("Agent initial Assignment without Origin Room status=%d want=400 body=%s", status, body)
	}

	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, ownerBase+"/work-items", teamHubInternalToken,
		"workflow-nonmember-assignment-"+suffix, map[string]any{
			"kind":               "issue",
			"title":              "Non-member Workflow node " + suffix,
			"origin_room_id":     roomID,
			"assignee_actor_ids": []string{nodeActorID},
		})
	if status != http.StatusNotFound {
		t.Fatalf("Agent initial Assignment to Origin Room non-member status=%d want=404 body=%s", status, body)
	}

	status, _, body = env.request(alice, http.MethodPut,
		"/v0/rooms/"+roomID+"/members/"+nodeActorID,
		map[string]any{"role": "member"}, "workflow-node-room-member-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("add Workflow node to Origin Room status=%d body=%s", status, body)
	}

	status, _, body = agentWorkItemRequest(t, env, http.MethodPost, ownerBase+"/work-items", teamHubInternalToken,
		"workflow-owner-create-task-"+suffix, map[string]any{
			"kind":               "issue",
			"title":              "Workflow node " + suffix,
			"origin_room_id":     roomID,
			"assignee_actor_ids": []string{nodeActorID},
		})
	if status != http.StatusCreated {
		t.Fatalf("Workflow owner create assigned Task status=%d body=%s", status, body)
	}
	var created workItemResponse
	decode(t, body, &created)
	if created.CreatedBy.ID != "actor_acme_official" || len(created.Assignees) != 1 || created.Assignees[0].Actor.ID != nodeActorID {
		t.Fatalf("Workflow Task ownership or Assignment is invalid: %+v", created)
	}

	nodeBase := "/v0/agents/" + nodeAgentManagementID
	status, _, body = agentWorkItemRequest(t, env, http.MethodPost,
		nodeBase+"/work-items/"+created.ID+"/transitions", teamHubInternalToken,
		"workflow-node-fail-task-"+suffix, map[string]any{
			"expected_version": created.Version,
			"state":            "resolved",
			"resolution":       "failed",
		})
	if status != http.StatusOK {
		t.Fatalf("assigned Workflow node fail Task status=%d body=%s", status, body)
	}
	var failed workItemResponse
	decode(t, body, &failed)
	if failed.State != "resolved" || failed.Resolution == nil || *failed.Resolution != "failed" {
		t.Fatalf("Workflow Task did not settle as failed: %+v", failed)
	}
}

func TestAgentWorkItemAssignmentLinearizesAfterOriginMemberRemoval(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Workflow assignment race "+suffix, "workflow-assignment-race-room-"+suffix)
	seedPeerAgent(t, env, "actor_assignment_peer")
	for _, actorID := range []string{"actor_acme_official", "actor_assignment_peer"} {
		status, _, body := env.request(alice, http.MethodPut,
			"/v0/rooms/"+roomID+"/members/"+actorID,
			map[string]any{"role": "member"}, "workflow-assignment-race-member-"+actorID+"-"+suffix)
		if status != http.StatusOK {
			t.Fatalf("add Origin Room member %s status=%d body=%s", actorID, status, body)
		}
	}

	blocker, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(t.Context(), `
		select pg_advisory_xact_lock(hashtextextended($1,0))
	`, "room-membership|"+roomID); err != nil {
		t.Fatal(err)
	}

	results := make(chan asyncHTTPResult, 2)
	if err := startAsyncJSONRequest(results, "remove", alice, http.MethodDelete,
		env.server.URL+"/v0/rooms/"+roomID+"/members/actor_assignment_peer", "", nil); err != nil {
		t.Fatal(err)
	}
	waitForBlockedAgentWorkItemMembershipQueries(t, env, 1)

	title := "Workflow assignment after removal " + suffix
	if err := startAsyncJSONRequestWithHeaders(results, "create", http.DefaultClient, http.MethodPost,
		env.server.URL+"/v0/agents/"+acmeOfficialAgentManagementID+"/work-items",
		"workflow-assignment-after-removal-"+suffix, map[string]any{
			"kind":               "issue",
			"title":              title,
			"origin_room_id":     roomID,
			"assignee_actor_ids": []string{"actor_assignment_peer"},
		}, http.Header{"Authorization": []string{"Bearer " + teamHubInternalToken}}); err != nil {
		t.Fatal(err)
	}
	waitForBlockedAgentWorkItemMembershipQueries(t, env, 2)
	if err := blocker.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		select {
		case result := <-results:
			if result.err != nil {
				t.Fatalf("%s request failed: %v", result.name, result.err)
			}
			if result.name == "remove" && result.status != http.StatusNoContent {
				t.Fatalf("remove Origin Room assignee status=%d body=%s", result.status, result.body)
			}
			if result.name == "create" && result.status != http.StatusNotFound {
				t.Fatalf("create after assignee removal status=%d want=404 body=%s", result.status, result.body)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("membership removal and Agent Work Item create did not finish")
		}
	}
	var createdCount int
	if err := env.pool.QueryRow(t.Context(), `select count(*) from work_items where title=$1`, title).Scan(&createdCount); err != nil {
		t.Fatal(err)
	}
	if createdCount != 0 {
		t.Fatalf("membership race left %d unauthorized Work Items", createdCount)
	}
}

func waitForBlockedAgentWorkItemMembershipQueries(t *testing.T, env *testEnv, want int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := env.pool.QueryRow(context.Background(), `
			select count(*)
			from pg_stat_activity
			where datname=current_database()
			  and pid<>pg_backend_pid()
			  and wait_event_type='Lock'
			  and position('AcquireAdvisoryTransactionLock' in query)>0
		`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d blocked Room membership operations", want)
}

func agentWorkItemRequest(t *testing.T, env *testEnv, method, path, token, key string, payload any) (int, http.Header, []byte) {
	t.Helper()
	var reader io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, env.server.URL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, response.Header, body
}
