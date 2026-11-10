package integration_test

import (
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestDocumentCommentRunsKeepPerCommentOrder(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true, jobPollInterval: 10 * time.Millisecond,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Queued comments "+suffix, "queued-comments-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, "queued-comments-agent-"+suffix)
	doc := createRoomDocumentForCommentRefs(t, env, alice, roomID, "Queued comments", "queued-comments-document-"+suffix)
	var threads []roomDocumentCommentThreadResponse
	var runIDs []string
	for index := range 3 {
		status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+doc.ID+"/comment-threads", map[string]any{
			"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
			"anchor":          map[string]any{"quoted_text": "selected text", "block_id": fmt.Sprintf("block_order_%d", index), "context_before": "", "context_after": ""},
			"initial_comment": map[string]any{"segments": []map[string]any{{"type": "text", "content": fmt.Sprintf("Request %d ", index+1)}, {"type": "reference", "content": "@official", "actor_id": "actor_acme_official"}}},
			"durable_head":    durableHeadPayload(doc.DurableHead.PersistedSeq, doc.DurableHead.StateHash, doc.DurableHead.StateHashVersion),
		}, fmt.Sprintf("queued-comment-%s-%d", suffix, index))
		if status != http.StatusCreated {
			t.Fatalf("create comment %d: status=%d body=%s", index, status, body)
		}
		var thread roomDocumentCommentThreadResponse
		decode(t, body, &thread)
		threads = append(threads, thread)
		runIDs = append(runIDs, waitForDocumentCommentRun(t, env, thread.Comments[0].ID))
	}
	assertContextResidency(t, env, doc.ID, "suspended")
	// Keep the third anchor pending while the first two are ready, as can happen
	// when comments arrive while the Context is already active.
	threadIDs := []string{threads[0].ID, threads[1].ID}
	slices.Sort(threadIDs)
	credential := openRoomDocumentSessionForCommentRefs(t, env, alice, doc.ID, "order-runtime-"+suffix)
	if check := validateCommentThreadRefs(t, env, doc.ID, threadIDs); check != "available" {
		t.Fatalf("check anchors: %s", check)
	}
	appendCommentThreadRefs(t, env, doc.ID, credential.claims(t).ActorID, "order-batch-"+suffix, 0, threadIDs)
	for _, runID := range runIDs[:2] {
		waitForDocumentCommentRunQueued(t, env, runID, "active")
	}
	assertContextResidency(t, env, doc.ID, "active")
	contextKey := fmt.Sprintf(`["document","%s","%s"]`, acmeOfficialAgentManagementID, doc.ID)
	assertRun := func(index int, wantStatus string, wantClaimable bool) {
		t.Helper()
		var status string
		var claimable bool
		if err := env.pool.QueryRow(t.Context(), `SELECT status,status='queued' AND agent_document_run_claimable(run_id,context_key)
			FROM agent_local_runs WHERE run_id=$1`, runIDs[index]).Scan(&status, &claimable); err != nil {
			t.Fatal(err)
		}
		if status != wantStatus || claimable != wantClaimable {
			t.Fatalf("comment %d run=%s claimable=%t want=%s/%t", index+1, status, claimable, wantStatus, wantClaimable)
		}
	}
	resolveDocumentCommentTrigger(t, env, doc.ID, threads[0].Comments[0].ID)
	resolveDocumentCommentTrigger(t, env, doc.ID, threads[0].Comments[0].ID) // Resolve writes nothing, so a repeat is safe.
	assertRun(0, "queued", true)
	assertRun(1, "queued", true)
	assertRun(2, "queued", false)
	queries := store.New(env.pool)
	if _, err := queries.ClaimAgentLocalRun(t.Context(), store.ClaimAgentLocalRunParams{Epoch: "order-epoch", ClaimID: "order-claim-" + suffix, ClaimConfigurationRevision: 1, RunID: runIDs[0], ContextKey: contextKey}); err != nil {
		t.Fatal(err)
	}
	// The running Run keeps serving the Context while later comments wait.
	resolveDocumentCommentTrigger(t, env, doc.ID, threads[0].Comments[0].ID)
	assertRun(1, "queued", true)
	if finished, err := queries.TerminateAgentLocalRuns(t.Context(), store.TerminateAgentLocalRunsParams{RunIds: []string{runIDs[0]}, Status: "succeeded", Terminal: []byte(`{"type":"succeeded","finalResponse":"done"}`)}); err != nil || len(finished) != 1 {
		t.Fatalf("finish first: finished=%v err=%v", finished, err)
	}
	resolveDocumentCommentTrigger(t, env, doc.ID, threads[1].Comments[0].ID)
	assertRun(0, "succeeded", false)
	assertRun(1, "queued", true)
	assertRun(2, "queued", false)
}

func TestDocumentCommentMcpResolveSkipsFailedQueuedRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true, jobPollInterval: 10 * time.Millisecond,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Zombie comment "+suffix, "zombie-comment-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, "zombie-comment-agent-"+suffix)
	doc := createRoomDocumentForCommentRefs(t, env, alice, roomID, "Zombie comment", "zombie-comment-document-"+suffix)
	createMention := func(blockID, key string) (thread roomDocumentCommentThreadResponse, runID string) {
		t.Helper()
		status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+doc.ID+"/comment-threads", map[string]any{
			"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
			"anchor":          map[string]any{"quoted_text": "selected text", "block_id": blockID, "context_before": "", "context_after": ""},
			"initial_comment": map[string]any{"segments": []map[string]any{{"type": "text", "content": "Explain "}, {"type": "reference", "content": "@official", "actor_id": "actor_acme_official"}}},
			"durable_head":    durableHeadPayload(doc.DurableHead.PersistedSeq, doc.DurableHead.StateHash, doc.DurableHead.StateHashVersion),
		}, key)
		if status != http.StatusCreated {
			t.Fatalf("create comment: status=%d body=%s", status, body)
		}
		decode(t, body, &thread)
		return thread, waitForDocumentCommentRun(t, env, thread.Comments[0].ID)
	}
	first, firstRun := createMention("block_zombie_1", "zombie-comment-"+suffix+"-1")
	second, secondRun := createMention("block_zombie_2", "zombie-comment-"+suffix+"-2")
	assertContextResidency(t, env, doc.ID, "suspended")
	credential := openRoomDocumentSessionForCommentRefs(t, env, alice, doc.ID, "zombie-runtime-"+suffix)
	if check := validateCommentThreadRefs(t, env, doc.ID, []string{first.ID}); check != "available" {
		t.Fatalf("check first: %s", check)
	}
	appendCommentThreadRefs(t, env, doc.ID, credential.claims(t).ActorID, "zombie-batch-1-"+suffix, 0, []string{first.ID})
	waitForDocumentCommentRunQueued(t, env, firstRun, "active")
	assertContextResidency(t, env, doc.ID, "active")
	status, _, body := env.request(alice, http.MethodPatch,
		"/v0/document-comment-threads/"+first.ID, map[string]any{"resolved": true},
		"zombie-resolve-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("resolve first thread: %d %s", status, body)
	}
	waitForDocumentCommentRunFailed(t, env, firstRun)
	if check := validateCommentThreadRefs(t, env, doc.ID, []string{second.ID}); check != "available" {
		t.Fatalf("check second: %s", check)
	}
	appendCommentThreadRefs(t, env, doc.ID, credential.claims(t).ActorID, "zombie-batch-2-"+suffix, 1, []string{second.ID})
	waitForDocumentCommentRunQueued(t, env, secondRun, "active")
	resolveDocumentCommentTrigger(t, env, doc.ID, second.Comments[0].ID)
}

// resolveDocumentCommentTrigger resolves the Document Context and checks that
// its comments.md belongs to the Run triggered by wantCommentID.
func resolveDocumentCommentTrigger(t *testing.T, env *testEnv, documentID, wantCommentID string) {
	t.Helper()
	status, _, body := agentWorkItemRequest(t, env, http.MethodPost, "/internal/agents/"+acmeOfficialAgentManagementID+"/mcp-context/actions/resolve", teamHubInternalToken, "", map[string]any{
		"context": map[string]any{"kind": "document", "document_id": documentID},
	})
	if status != http.StatusOK {
		t.Fatalf("resolve: status=%d body=%s", status, body)
	}
	var result struct {
		DocumentComment struct {
			CommentsMarkdown string `json:"comments_markdown"`
		} `json:"document_comment_runtime"`
	}
	decode(t, body, &result)
	if !strings.Contains(result.DocumentComment.CommentsMarkdown, "trigger_comment_id: "+wantCommentID+"\n") {
		t.Fatalf("resolved comments.md for another trigger, want %s: %s", wantCommentID, result.DocumentComment.CommentsMarkdown)
	}
}

func assertContextResidency(t *testing.T, env *testEnv, documentID, want string) {
	t.Helper()
	var got string
	if err := env.pool.QueryRow(t.Context(), `SELECT target_residency FROM agent_execution_contexts WHERE document_id=$1`, documentID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("document context residency=%s want=%s", got, want)
	}
}
