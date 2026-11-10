package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	documentservice "github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// TestStandaloneDocumentCommentMentionStartsRun covers Library comments without a Room binding.
func TestStandaloneDocumentCommentMentionStartsRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, scenario := range []string{"create", "reply", "edit", "edit_existing_mention", "resolved_reply", "resolved_edit"} {
		t.Run(scenario, func(t *testing.T) {
			action := strings.TrimPrefix(scenario, "resolved_")
			if scenario == "edit_existing_mention" {
				action = "edit"
			}
			resolved := strings.HasPrefix(scenario, "resolved_")
			env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
				revisionExport: true, jobPollInterval: 10 * time.Millisecond,
			})
			suffix := action + strconv.FormatInt(time.Now().UnixNano(), 36)
			status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{}, "")
			if status != http.StatusCreated {
				t.Fatalf("create Library Document: %d %s", status, body)
			}
			var doc roomDocumentResponse
			decode(t, body, &doc)
			head := loadRoomDocumentDurableHeadForCommentRefs(t, env, alice, doc.ID)
			segments := []map[string]any{{"type": "text", "content": "Review this "}, {"type": "reference", "content": "@official", "actor_id": "actor_acme_official"}}
			initial := segments
			if action != "create" && scenario != "edit_existing_mention" {
				initial = []map[string]any{{"type": "text", "content": "A plain comment"}}
			}
			status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+doc.ID+"/comment-threads", map[string]any{
				"anchor":          map[string]any{"quoted_text": "selected text", "block_id": "block_" + suffix},
				"initial_comment": map[string]any{"segments": initial},
				"durable_head":    durableHeadPayload(head.PersistedSeq, head.StateHash, head.StateHashVersion),
			}, "standalone-thread-"+suffix)
			if status != http.StatusCreated {
				t.Fatalf("create thread: %d %s", status, body)
			}
			var thread roomDocumentCommentThreadResponse
			decode(t, body, &thread)
			commentID := thread.Comments[0].ID
			if scenario == "edit_existing_mention" {
				segments = []map[string]any{{"type": "text", "content": "Updated review request "}, {"type": "reference", "content": "@official", "actor_id": "actor_acme_official"}}
			}
			if resolved {
				status, _, body = env.request(alice, http.MethodPatch, "/v0/document-comment-threads/"+thread.ID, map[string]any{"resolved": true}, "")
				if status != http.StatusOK {
					t.Fatalf("resolve thread: %d %s", status, body)
				}
			}
			if action != "create" {
				method, path, want := http.MethodPost, "/v0/document-comment-threads/"+thread.ID+"/comments", http.StatusCreated
				payload := map[string]any{"segments": segments, "durable_head": durableHeadPayload(head.PersistedSeq, head.StateHash, head.StateHashVersion)}
				if action == "edit" {
					method, path, want = http.MethodPatch, "/v0/document-comments/"+commentID, http.StatusOK
					payload["expected_version"] = 1
				}
				status, _, body = env.request(alice, method, path, payload, "standalone-mention-"+suffix)
				if resolved {
					if status != http.StatusConflict {
						t.Fatalf("resolved %s mention: %d %s", action, status, body)
					}
					if got := countRows(t, env, `SELECT count(*) FROM agent_execution_contexts WHERE document_id=$1`, doc.ID); got != 0 {
						t.Fatalf("resolved thread created %d contexts", got)
					}
					if got := countRows(t, env, `SELECT count(*) FROM room_document_comments WHERE document_id=$1 AND body='A plain comment' AND version_number=1`, doc.ID); got != 1 {
						t.Fatalf("rejected mention changed original comment: %d", got)
					}
					return
				}
				if status != want {
					t.Fatalf("%s mention: %d %s", action, status, body)
				}
				var comment struct {
					ID string `json:"id"`
				}
				decode(t, body, &comment)
				commentID = comment.ID
			}
			if scenario == "edit_existing_mention" {
				// A saved mention is not a second invocation when its text changes.
				// Retrying with the old comment version must leave the new text intact.
				status, _, body = env.request(alice, http.MethodPatch, "/v0/document-comments/"+commentID, map[string]any{
					"expected_version": 1,
					"segments":         []map[string]any{{"type": "text", "content": "Stale overwrite must not persist"}},
					"durable_head":     durableHeadPayload(head.PersistedSeq, head.StateHash, head.StateHashVersion),
				}, "standalone-stale-edit-"+suffix)
				if status != http.StatusConflict {
					t.Fatalf("stale comment edit: %d %s", status, body)
				}
				if got := countRows(t, env, `SELECT count(*) FROM room_document_comments WHERE id=$1 AND version_number=2 AND body LIKE 'Updated review request%'`, commentID); got != 1 {
					t.Fatalf("stale edit lost the accepted comment update: %d", got)
				}
				if got := countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE source_message_id=$1 AND source_kind='inbox'`, commentID); got != 1 {
					t.Fatalf("editing existing mention left %d invocation inputs, want one", got)
				}
			}
			// Enqueue is atomic with the saved mention; no polling should hide a missing Run.
			var runID, contextKey string
			if err := env.pool.QueryRow(t.Context(), `SELECT local_run_id,context_key FROM agent_runtime_inputs WHERE source_message_id=$1 AND source_kind='inbox'`, commentID).Scan(&runID, &contextKey); err != nil {
				t.Fatalf("saved standalone %s mention has no Run: %v", action, err)
			}
			queries := store.New(env.pool)
			ready, err := queries.AgentRuntimeContextHasQueuedRun(t.Context(), contextKey)
			if err != nil || ready {
				t.Fatalf("pending anchor ready=%t err=%v", ready, err)
			}
			attachDocumentAgentThread(t, env, alice, doc.ID, thread.ID, suffix)
			if scenario == "edit_existing_mention" {
				// The contract invalidates queued input when its source comment changes.
				// Keeping the mention does not enqueue a replacement for the same Agent.
				waitForDocumentCommentRunFailed(t, env, runID)
				if _, err := queries.ClaimAgentLocalRun(t.Context(), store.ClaimAgentLocalRunParams{
					Epoch: "standalone-epoch", ClaimID: "standalone-edited-claim-" + suffix, ClaimConfigurationRevision: 1, RunID: runID, ContextKey: contextKey,
				}); !errors.Is(err, pgx.ErrNoRows) {
					t.Fatalf("edited mention claim error=%v, want no rows", err)
				}
				if got := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE document_id=$1`, doc.ID); got != 0 {
					t.Fatalf("edited standalone mention invented %d bindings", got)
				}
				return
			}
			waitForDocumentCommentRunQueued(t, env, runID, "active")
			ready, err = queries.AgentRuntimeContextHasQueuedRun(t.Context(), contextKey)
			if err != nil || !ready {
				t.Fatalf("attached standalone mention ready=%t err=%v", ready, err)
			}
			status, _, body = agentWorkItemRequest(t, env, http.MethodPost,
				"/internal/agents/"+acmeOfficialAgentManagementID+"/mcp-context/actions/resolve", teamHubInternalToken, "",
				map[string]any{"context": map[string]any{"kind": "document", "document_id": doc.ID}})
			if status != http.StatusOK || !strings.Contains(string(body), commentID) {
				t.Fatalf("standalone Agent input: %d %s", status, body)
			}
			if _, err := queries.ClaimAgentLocalRun(t.Context(), store.ClaimAgentLocalRunParams{
				Epoch: "standalone-epoch", ClaimID: "standalone-claim-" + suffix, ClaimConfigurationRevision: 1, RunID: runID, ContextKey: contextKey,
			}); err != nil {
				t.Fatalf("claim standalone Run: %v", err)
			}
			if got := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE document_id=$1`, doc.ID); got != 0 {
				t.Fatalf("invented Room binding count=%d", got)
			}
		})
	}
}

func TestHumanDocumentCommentAgentMentionCreatesOneDocumentContextAcrossRooms(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport:  true,
		jobPollInterval: 10 * time.Millisecond,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Document Context "+suffix, "document-context-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, "document-context-member-"+suffix)
	document := createRoomDocumentForCommentRefs(
		t, env, alice, roomID, "Document Context", "document-context-document-"+suffix,
	)

	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor": map[string]any{
			"quoted_text": "selected text", "block_id": "block_document_context",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{"segments": []map[string]any{
			{"type": "text", "content": "Please update "},
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		}},
		"durable_head": durableHeadPayload(
			document.DurableHead.PersistedSeq, document.DurableHead.StateHash, document.DurableHead.StateHashVersion,
		),
	}, "document-context-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent-mentioned Comment status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	trigger := thread.Comments[0]

	localRunID := waitForDocumentCommentRun(t, env, trigger.ID)
	var contextKey, residency, contextKind, contextDocumentID, runStatus string
	var notification, commentsMarkdown string
	var inputSequence int64
	if err := env.pool.QueryRow(t.Context(), `SELECT local_run.context_key,
			execution_context.target_residency,execution_context.context_kind,execution_context.document_id,
			local_run.status,runtime_input.input_sequence,
			runtime_input.payload->>'rawMessage',runtime_input.payload->>'documentCommentsMarkdown'
		FROM agent_local_runs local_run
		JOIN agent_execution_contexts execution_context ON execution_context.context_key=local_run.context_key
		JOIN agent_runtime_inputs runtime_input
		  ON runtime_input.context_key=local_run.context_key AND runtime_input.local_run_id=local_run.run_id
		WHERE local_run.run_id=$1`, localRunID).Scan(
		&contextKey, &residency, &contextKind, &contextDocumentID,
		&runStatus, &inputSequence, &notification, &commentsMarkdown,
	); err != nil {
		t.Fatal(err)
	}
	wantContextKey := fmt.Sprintf(`["document","%s","%s"]`, acmeOfficialAgentManagementID, document.ID)
	if contextKey != wantContextKey || contextKind != "document" || contextDocumentID != document.ID ||
		residency != "suspended" || runStatus != "queued" || inputSequence != 1 {
		t.Fatalf("invalid Document Local Run context=%q kind=%q document=%q residency=%s run=%s input=%d",
			contextKey, contextKind, contextDocumentID, residency, runStatus, inputSequence)
	}
	for _, expected := range []string{"Document comment mention", "thread_id: " + thread.ID, "trigger_comment_id: " + trigger.ID,
		"Full comments: ./" + document.ID + "/comments.md", "Current document: ./" + document.ID + "/latest.md"} {
		if !strings.Contains(notification, expected) {
			t.Fatalf("notification missing %q: %s", expected, notification)
		}
	}
	for _, expected := range []string{"# Document comment thread", "thread_id: " + thread.ID, trigger.ID, "selected text"} {
		if !strings.Contains(commentsMarkdown, expected) {
			t.Fatalf("comments.md projection missing %q: %s", expected, commentsMarkdown)
		}
	}

	queries := store.New(env.pool)
	dispatchable, err := queries.AgentRuntimeContextHasQueuedRun(t.Context(), contextKey)
	if err != nil {
		t.Fatal(err)
	}
	if dispatchable {
		t.Fatal("pending Comment anchor made its Local Run dispatchable")
	}
	if _, err := queries.ClaimAgentLocalRun(t.Context(), store.ClaimAgentLocalRunParams{
		Epoch: "document-epoch", ClaimID: "blocked-document-claim-" + suffix, ClaimConfigurationRevision: 1,
		RunID: localRunID, ContextKey: contextKey,
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("pending Comment anchor claim error=%v want no rows", err)
	}

	status, _, body = agentWorkItemRequest(t, env, http.MethodPost,
		"/internal/agents/"+acmeOfficialAgentManagementID+"/mcp-context/actions/resolve",
		teamHubInternalToken, "", map[string]any{
			"context": map[string]any{"kind": "document", "document_id": document.ID},
		})
	if status != http.StatusForbidden || !strings.Contains(string(body), "context_identity_invalid") {
		t.Fatalf("resolve pending Document MCP Context status=%d body=%s", status, body)
	}

	currentSeq, currentHash := attachDocumentAgentThread(t, env, alice, document.ID, thread.ID, suffix)
	waitForDocumentCommentRunQueued(t, env, localRunID, "active")
	dispatchable, err = queries.AgentRuntimeContextHasQueuedRun(t.Context(), contextKey)
	if err != nil || !dispatchable {
		t.Fatalf("attached Comment Local Run dispatchable=%t err=%v", dispatchable, err)
	}

	status, _, body = agentWorkItemRequest(t, env, http.MethodPost,
		"/internal/agents/"+acmeOfficialAgentManagementID+"/mcp-context/actions/resolve",
		teamHubInternalToken, "", map[string]any{
			"context": map[string]any{"kind": "document", "document_id": document.ID},
		})
	if status != http.StatusOK {
		t.Fatalf("resolve Document MCP Context status=%d body=%s", status, body)
	}
	var resolved struct {
		AgentID         string `json:"agent_id"`
		DocumentComment struct {
			CommentsMarkdown string `json:"comments_markdown"`
			CurrentDocument  struct {
				Content    []byte `json:"content"`
				DocumentID string `json:"document_id"`
				Filename   string `json:"filename"`
				MediaType  string `json:"media_type"`
				SizeBytes  int64  `json:"size_bytes"`
				SHA256     string `json:"sha256"`
			} `json:"current_document"`
		} `json:"document_comment_runtime"`
	}
	decode(t, body, &resolved)
	if resolved.AgentID != acmeOfficialAgentManagementID ||
		resolved.DocumentComment.CommentsMarkdown != commentsMarkdown ||
		resolved.DocumentComment.CurrentDocument.DocumentID != document.ID ||
		resolved.DocumentComment.CurrentDocument.Filename == "" ||
		resolved.DocumentComment.CurrentDocument.MediaType != "text/markdown" ||
		resolved.DocumentComment.CurrentDocument.SizeBytes != int64(len(resolved.DocumentComment.CurrentDocument.Content)) ||
		resolved.DocumentComment.CurrentDocument.SHA256 != semanticDigest(resolved.DocumentComment.CurrentDocument.Content) {
		t.Fatalf("invalid Document MCP projection: %s", body)
	}
	if _, err := queries.ClaimAgentLocalRun(t.Context(), store.ClaimAgentLocalRunParams{
		Epoch: "document-epoch", ClaimID: "claim-first-document-run-" + suffix, ClaimConfigurationRevision: 1,
		RunID: localRunID, ContextKey: contextKey,
	}); err != nil {
		t.Fatalf("claim first Document Local Run: %v", err)
	}
	if finished, err := queries.TerminateAgentLocalRuns(t.Context(), store.TerminateAgentLocalRunsParams{
		Status: "succeeded", Terminal: []byte(`{"type":"succeeded","finalResponse":"done"}`),
		RunIds: []string{localRunID},
	}); err != nil || len(finished) != 1 {
		t.Fatalf("finish first Document Local Run finished=%v err=%v", finished, err)
	}

	secondRoomID := createPrivateRoom(t, env, alice, "Second Document Context "+suffix, "second-document-context-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, secondRoomID, "second-document-context-member-"+suffix)
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO document_context_bindings(
		id,tenant_id,document_id,binding_kind,room_id,status
	) VALUES($1,$2,$3,'room',$4,'active')`, "binding_second_document_context_"+suffix,
		acmeTenant, document.ID, secondRoomID); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodPost,
		"/v0/document-comment-threads/"+thread.ID+"/comments", map[string]any{
			"current_context": map[string]any{"binding_kind": "room", "context_id": secondRoomID},
			"segments": []map[string]any{
				{"type": "text", "content": "Second Room request "},
				{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
			},
			"durable_head": durableHeadPayload(currentSeq, currentHash, 1),
		}, "second-room-document-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("second Room Agent mention status=%d body=%s", status, body)
	}
	var secondComment struct {
		ID string `json:"id"`
	}
	decode(t, body, &secondComment)
	secondRunID := waitForDocumentCommentRun(t, env, secondComment.ID)
	waitForDocumentCommentRunQueued(t, env, secondRunID, "active")

	var contexts, runs, triggers, origins int
	var minimumSequence, maximumSequence int64
	if err := env.pool.QueryRow(t.Context(), `SELECT
			(SELECT count(*) FROM agent_execution_contexts context
			 WHERE context.context_kind='document' AND context.agent_management_id=$1 AND context.document_id=$2),
			(SELECT count(*) FROM agent_local_runs run WHERE run.context_key=$3),
			(SELECT count(*) FROM agent_runtime_inputs input WHERE input.context_key=$3 AND input.source_kind='inbox'),
			(SELECT count(DISTINCT input.payload->>'documentCommentRoomId') FROM agent_runtime_inputs input
			 WHERE input.context_key=$3),
			(SELECT min(input.input_sequence) FROM agent_runtime_inputs input WHERE input.context_key=$3),
			(SELECT max(input.input_sequence) FROM agent_runtime_inputs input WHERE input.context_key=$3)`,
		acmeOfficialAgentManagementID, document.ID, contextKey).Scan(
		&contexts, &runs, &triggers, &origins, &minimumSequence, &maximumSequence,
	); err != nil {
		t.Fatal(err)
	}
	if contexts != 1 || runs != 2 || triggers != 2 || origins != 2 || minimumSequence != 1 || maximumSequence != 2 {
		t.Fatalf("per-Document serialization contexts=%d runs=%d triggers=%d origins=%d sequence=%d..%d",
			contexts, runs, triggers, origins, minimumSequence, maximumSequence)
	}

	status, _, body = agentWorkItemRequest(t, env, http.MethodPost,
		"/internal/agents/"+acmeOfficialAgentManagementID+"/mcp-context/actions/resolve",
		teamHubInternalToken, "", map[string]any{
			"context": map[string]any{"kind": "document", "document_id": document.ID},
		})
	if status != http.StatusOK {
		t.Fatalf("resolve second Document MCP Context status=%d body=%s", status, body)
	}
	var secondCommentsMarkdown string
	if err := env.pool.QueryRow(t.Context(), `SELECT payload->>'documentCommentsMarkdown'
		FROM agent_runtime_inputs WHERE local_run_id=$1`, secondRunID).Scan(&secondCommentsMarkdown); err != nil {
		t.Fatal(err)
	}
	var secondResolved struct {
		DocumentComment struct {
			CommentsMarkdown string `json:"comments_markdown"`
		} `json:"document_comment_runtime"`
	}
	decode(t, body, &secondResolved)
	if secondResolved.DocumentComment.CommentsMarkdown != secondCommentsMarkdown ||
		!strings.Contains(secondCommentsMarkdown, "trigger_comment_id: "+secondComment.ID) {
		t.Fatalf("second Document Run comments.md mismatch: %s", body)
	}

	status, _, body = env.request(alice, http.MethodPatch, "/v0/document-comments/"+trigger.ID, map[string]any{
		"current_context":  map[string]any{"binding_kind": "room", "context_id": roomID},
		"expected_version": 1,
		"segments": []map[string]any{
			{"type": "text", "content": "Still update "},
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		},
		"durable_head": durableHeadPayload(currentSeq, currentHash, 1),
	}, "repeat-logical-document-comment-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("repeat logical Agent mention status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_local_runs WHERE context_key=$1`, contextKey); got != 2 {
		t.Fatalf("repeat logical mention created %d Document Runs want=2", got)
	}
}

func TestDocumentCommentTextReplacementCommitsRevisionHistoryAndProjection(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true, jobPollInterval: 10 * time.Millisecond,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Document replacement "+suffix, "document-replacement-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, "document-replacement-member-"+suffix)
	document := createRoomDocumentForCommentRefs(
		t, env, alice, roomID, "Document replacement", "document-replacement-document-"+suffix,
	)
	thread := createPlainDocumentCommentThread(t, env, alice, document, roomID, "replacement-"+suffix)
	attachDocumentAgentThread(t, env, alice, document.ID, thread.ID, "replacement-"+suffix)
	principal := issueAgentPrincipal(t, env.pool, acmeOfficialAgentManagementID)

	objects, err := artifactstore.NewLocalStore(env.artifactRoot, 32<<20)
	if err != nil {
		t.Fatal(err)
	}
	semanticCalls, projectionCalls := 0, 0
	projection := []byte("# Revised\n")
	service := documentservice.NewWithRuntime(env.pool, documentRuntimeStub{export: func(
		_ context.Context,
		input documentservice.ExportRuntimeRequest,
	) (documentservice.ExportRuntimeResult, error) {
		projectionCalls++
		digest := sha256.Sum256(projection)
		return documentservice.ExportRuntimeResult{
			MediaType: "text/markdown",
			Bytes:     projection, SizeBytes: int64(len(projection)), SHA256: hex.EncodeToString(digest[:]),
			CompleteAssetIDs: input.CompleteAssetIDs, CompleteThreadIDs: input.CompleteThreadIDs,
			Warnings: input.Warnings,
		}, nil
	}, apply: applyToBody(env.pool, func(
		input documentservice.ApplyRequest, _ []byte,
	) ([]byte, []byte, []string, []string, string, error) {
		semanticCalls++
		var operations []map[string]string
		if err := json.Unmarshal(input.Semantic.Operations, &operations); err != nil || len(operations) != 1 ||
			operations[0]["kind"] != "replace_comment_text" || operations[0]["thread_id"] != thread.ID ||
			operations[0]["replacement"] != "Revised" {
			t.Fatalf("replacement semantic operation=%s err=%v", input.Semantic.Operations, err)
		}
		return []byte{4, 5, 6}, []byte{2}, nil, []string{thread.ID}, input.Semantic.CurrentTitle, nil
	})}, objects)
	result, err := service.ApplyCommentTextReplacement(t.Context(), documentservice.ApplyCommentTextReplacementInput{
		Principal: principal, DocumentID: document.ID, ThreadID: thread.ID,
		SourceInvocationID: "document-replacement-invocation-" + suffix, Replacement: "Revised",
	})
	if err != nil || result.Status != documentservice.SemanticMutationApplied || result.Replayed ||
		result.RevisionID == "" || result.HistoryEntryID == "" || string(result.CurrentMarkdown) != string(projection) ||
		result.CurrentMarkdownSHA256 != semanticDigest(projection) || semanticCalls != 1 || projectionCalls != 1 {
		t.Fatalf("replacement result=%+v semantic_calls=%d projection_calls=%d err=%v",
			result, semanticCalls, projectionCalls, err)
	}
	if got := countRows(t, env, `SELECT count(*) FROM document_revisions WHERE id=$1 AND document_id=$2`,
		result.RevisionID, document.ID); got != 1 {
		t.Fatalf("replacement committed %d Revision rows", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM document_revisions WHERE id=$1 AND document_id=$2 AND history_trigger IS NOT NULL`,
		result.HistoryEntryID, document.ID); got != 1 {
		t.Fatalf("replacement committed %d History rows", got)
	}
}

func TestResolvedDocumentCommentMentionNeverDispatchesAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport:  true,
		jobPollInterval: 10 * time.Millisecond,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Resolved Document Context "+suffix, "resolved-document-context-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, "resolved-document-context-member-"+suffix)
	document := createRoomDocumentForCommentRefs(
		t, env, alice, roomID, "Resolved Document Context", "resolved-document-context-document-"+suffix,
	)

	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor": map[string]any{
			"quoted_text": "selected text", "block_id": "block_resolved_document_context",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{"segments": []map[string]any{
			{"type": "text", "content": "Please update "},
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		}},
		"durable_head": durableHeadPayload(
			document.DurableHead.PersistedSeq, document.DurableHead.StateHash, document.DurableHead.StateHashVersion,
		),
	}, "resolved-document-context-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent-mentioned Comment status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	runID := waitForDocumentCommentRun(t, env, thread.Comments[0].ID)

	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/document-comment-threads/"+thread.ID, map[string]any{"resolved": true},
		"resolved-document-context-resolution-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("resolve Agent-mentioned Comment status=%d body=%s", status, body)
	}
	waitForDocumentCommentRunFailed(t, env, runID)

	contextKey := documentCommentRunContextKey(t, env, runID)
	dispatchable, err := store.New(env.pool).AgentRuntimeContextHasQueuedRun(t.Context(), contextKey)
	if err != nil {
		t.Fatal(err)
	}
	if dispatchable {
		t.Fatal("resolved Comment Thread made its Document Local Run dispatchable")
	}
}

func TestResolvedActiveDocumentCommentMentionFailsQueuedRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true, jobPollInterval: 10 * time.Millisecond,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Resolved Active Document Context "+suffix, "resolved-active-document-context-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, "resolved-active-document-context-member-"+suffix)
	document := createRoomDocumentForCommentRefs(
		t, env, alice, roomID, "Resolved Active Document Context", "resolved-active-document-context-document-"+suffix,
	)

	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor": map[string]any{
			"quoted_text": "selected text", "block_id": "block_resolved_active_document_context",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{"segments": []map[string]any{
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		}},
		"durable_head": durableHeadPayload(
			document.DurableHead.PersistedSeq, document.DurableHead.StateHash, document.DurableHead.StateHashVersion,
		),
	}, "resolved-active-document-context-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent-mentioned Comment status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	runID := waitForDocumentCommentRun(t, env, thread.Comments[0].ID)
	attachDocumentAgentThread(t, env, alice, document.ID, thread.ID, "resolved-active-"+suffix)
	waitForDocumentCommentRunQueued(t, env, runID, "active")

	status, _, body = env.request(alice, http.MethodPatch,
		"/v0/document-comment-threads/"+thread.ID, map[string]any{"resolved": true},
		"resolved-active-document-context-resolution-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("resolve active Agent-mentioned Comment status=%d body=%s", status, body)
	}
	waitForDocumentCommentRunFailed(t, env, runID)

	contextKey := documentCommentRunContextKey(t, env, runID)
	dispatchable, err := store.New(env.pool).AgentRuntimeContextHasQueuedRun(t.Context(), contextKey)
	if err != nil {
		t.Fatal(err)
	}
	if dispatchable {
		t.Fatal("resolved active Comment Thread kept its Document Local Run dispatchable")
	}
}

func TestExpiredQueuedDocumentCommentRunFails(t *testing.T) {
	allowParallelIntegrationTest(t)
	start := time.Now()
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true, jobPollInterval: 10 * time.Millisecond,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Expired Document Context "+suffix, "expired-document-context-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, "expired-document-context-member-"+suffix)
	document := createRoomDocumentForCommentRefs(t, env, alice, roomID, "Expired Document Context", "expired-document-context-document-"+suffix)

	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor": map[string]any{
			"quoted_text": "selected text", "block_id": "block_expired_document_context",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{"segments": []map[string]any{
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		}},
		"durable_head": durableHeadPayload(document.DurableHead.PersistedSeq, document.DurableHead.StateHash, 1),
	}, "expired-document-context-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create expiring Document Comment status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	runID := waitForDocumentCommentRun(t, env, thread.Comments[0].ID)
	attachDocumentAgentThread(t, env, alice, document.ID, thread.ID, "expired-"+suffix)
	waitForDocumentCommentRunQueued(t, env, runID, "active")
	// Only the periodic sweep fails a Run that has waited 24 hours, so wait
	// until it runs before the business wait below starts.
	waitForRiverSweepRan(t, env, "maintenance.document_comment_input", start)

	expirationTx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer expirationTx.Rollback(t.Context())
	if _, err := expirationTx.Exec(t.Context(), `SET LOCAL session_replication_role='replica'`); err != nil {
		t.Fatal(err)
	}
	command, err := expirationTx.Exec(t.Context(), `UPDATE agent_local_runs
		SET created_at=clock_timestamp()-interval '25 hours'
		WHERE run_id=$1 AND status='queued'`, runID)
	if err != nil || command.RowsAffected() != 1 {
		t.Fatalf("expire Document comment Run changed=%d err=%v", command.RowsAffected(), err)
	}
	if err := expirationTx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	waitForDocumentCommentRunFailed(t, env, runID)
}

func TestHumanDocumentCommentAgentMentionRequiresExactDurableHead(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, entry := range []string{"room", "standalone"} {
		t.Run(entry, func(t *testing.T) {
			env, alice := newRoomDocumentRealtimeEnv(t)
			suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
			var roomID string
			var document roomDocumentResponse
			if entry == "room" {
				roomID = createPrivateRoom(t, env, alice, "Document head "+suffix, "document-head-room-"+suffix)
				addDocumentAgentToRoom(t, env, alice, roomID, "document-head-member-"+suffix)
				document = createRoomDocumentForCommentRefs(t, env, alice, roomID, "Document head", "document-head-"+suffix)
			} else {
				status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/documents", map[string]any{}, "")
				if status != http.StatusCreated {
					t.Fatalf("create standalone Document: %d %s", status, body)
				}
				decode(t, body, &document)
				document.DurableHead = loadRoomDocumentDurableHeadForCommentRefs(t, env, alice, document.ID)
			}
			request := func(head any) map[string]any {
				payload := map[string]any{
					"anchor": map[string]any{"quoted_text": "target", "block_id": "block_head", "context_before": "", "context_after": ""},
					"initial_comment": map[string]any{"segments": []map[string]any{
						{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
					}},
				}
				if roomID != "" {
					payload["current_context"] = map[string]any{"binding_kind": "room", "context_id": roomID}
				}
				if head != nil {
					payload["durable_head"] = head
				}
				return payload
			}
			path := "/v0/documents/" + document.ID + "/comment-threads"
			status, _, body := env.request(alice, http.MethodPost, path, request(nil), "missing-document-head-"+suffix)
			if status != http.StatusBadRequest {
				t.Fatalf("missing durable head status=%d body=%s", status, body)
			}
			status, _, body = env.request(alice, http.MethodPost, path, request(durableHeadPayload(
				document.DurableHead.PersistedSeq+1, document.DurableHead.StateHash, document.DurableHead.StateHashVersion,
			)), "stale-document-head-"+suffix)
			if status != http.StatusConflict {
				t.Fatalf("stale durable head status=%d body=%s", status, body)
			}
			if got := countRows(t, env, `SELECT count(*) FROM agent_execution_contexts WHERE context_kind='document' AND document_id=$1`, document.ID); got != 0 {
				t.Fatalf("failed durable heads created %d Document contexts", got)
			}
			if got := countRows(t, env, `SELECT count(*) FROM room_document_comment_threads WHERE document_id=$1`, document.ID); got != 0 {
				t.Fatalf("failed durable heads left %d comment threads", got)
			}
			if entry == "standalone" {
				if got := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE document_id=$1`, document.ID); got != 0 {
					t.Fatalf("standalone refusal invented %d bindings", got)
				}
			}
		})
	}
}

func TestDocumentCommentLatestProjectionFailureDoesNotFailQueuedRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithInvalidRevisionExport(t)
	objectsBefore, err := os.ReadDir(env.artifactRoot)
	if err != nil {
		t.Fatal(err)
	}
	beforeNames := make([]string, len(objectsBefore))
	for index := range objectsBefore {
		beforeNames[index] = objectsBefore[index].Name()
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Document failure "+suffix, "document-failure-room-"+suffix)
	addDocumentAgentToRoom(t, env, alice, roomID, "document-failure-member-"+suffix)
	document := createRoomDocumentForCommentRefs(t, env, alice, roomID, "Document failure", "document-failure-"+suffix)
	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor":          map[string]any{"quoted_text": "target", "block_id": "block_failure", "context_before": "", "context_after": ""},
		"initial_comment": map[string]any{"segments": []map[string]any{
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		}},
		"durable_head": durableHeadPayload(document.DurableHead.PersistedSeq, document.DurableHead.StateHash, 1),
	}, "document-failure-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent-mentioned Comment status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	runID := waitForDocumentCommentRun(t, env, thread.Comments[0].ID)
	attachDocumentAgentThread(t, env, alice, document.ID, thread.ID, "failure-"+suffix)
	waitForDocumentCommentRunQueued(t, env, runID, "active")

	status, _, body = agentWorkItemRequest(t, env, http.MethodPost,
		"/internal/agents/"+acmeOfficialAgentManagementID+"/mcp-context/actions/resolve",
		teamHubInternalToken, "", map[string]any{
			"context": map[string]any{"kind": "document", "document_id": document.ID},
		})
	if status != http.StatusServiceUnavailable || !strings.Contains(string(body), "dependency_unavailable") {
		t.Fatalf("resolve invalid latest projection status=%d body=%s", status, body)
	}

	var residency, runStatus string
	if err := env.pool.QueryRow(t.Context(), `SELECT execution_context.target_residency,local_run.status
		FROM agent_local_runs local_run
		JOIN agent_execution_contexts execution_context ON execution_context.context_key=local_run.context_key
		WHERE local_run.run_id=$1`, runID).Scan(&residency, &runStatus); err != nil {
		t.Fatal(err)
	}
	if residency != "active" || runStatus != "queued" {
		t.Fatalf("latest failure residency=%q run=%q", residency, runStatus)
	}
	objectsAfter, err := os.ReadDir(env.artifactRoot)
	if err != nil {
		t.Fatal(err)
	}
	afterNames := make([]string, len(objectsAfter))
	for index := range objectsAfter {
		afterNames[index] = objectsAfter[index].Name()
	}
	if !slices.Equal(beforeNames, afterNames) {
		t.Fatalf("invalid latest projection changed ObjectStore entries before=%v after=%v", beforeNames, afterNames)
	}
}

// A comment @Agent dispatches work with no share or other grant on the
// Document, because the Agent has its Human's Document access.
func TestRoomDocumentCommentMentionDispatchesAgentWithoutGrant(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport:  true,
		jobPollInterval: 10 * time.Millisecond,
	})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Mention "+suffix, "agent-mention-room-"+suffix)
	document := createRoomDocumentForCommentRefs(
		t, env, alice, roomID, "Mention Document", "agent-mention-document-"+suffix,
	)
	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor": map[string]any{
			"quoted_text": "selected text", "block_id": "block_agent_mention",
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{"segments": []map[string]any{
			{"type": "text", "content": "Please review "},
			{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
		}},
		"durable_head": durableHeadPayload(
			document.DurableHead.PersistedSeq, document.DurableHead.StateHash, document.DurableHead.StateHashVersion,
		),
	}, "agent-mention-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("Room comment @ Agent status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	localRunID := waitForDocumentCommentRun(t, env, thread.Comments[0].ID)
	var contextKey, runStatus string
	if err := env.pool.QueryRow(t.Context(), `SELECT context_key,status FROM agent_local_runs
		WHERE run_id=$1`, localRunID).Scan(&contextKey, &runStatus); err != nil {
		t.Fatalf("mention Local Run: %v", err)
	}
	if runStatus != "queued" {
		t.Fatalf("mention Local Run id=%q status=%q", localRunID, runStatus)
	}
	attachDocumentAgentThread(t, env, alice, document.ID, thread.ID, "mention-attach-"+suffix)
	waitForDocumentCommentRunQueued(t, env, localRunID, "active")
	dispatchable, err := store.New(env.pool).AgentRuntimeContextHasQueuedRun(t.Context(), contextKey)
	if err != nil || !dispatchable {
		t.Fatalf("mention Local Run dispatchable=%t err=%v", dispatchable, err)
	}

	var stateRevision int64
	if err := env.pool.QueryRow(t.Context(), `SELECT state_revision FROM agent_execution_contexts WHERE context_key=$1`, contextKey).Scan(&stateRevision); err != nil {
		t.Fatal(err)
	}
	resumeStatus, _, resumeBody := agentWorkItemRequest(t, env, http.MethodPost,
		"/v0/agent-runtime/contexts/residency", teamHubInternalToken, "", map[string]any{
			"context_key": contextKey, "expected_revision": strconv.FormatInt(stateRevision, 10), "target_residency": "active",
		})
	if resumeStatus != http.StatusOK {
		t.Errorf("mentioned Agent work must resume: status=%d body=%s", resumeStatus, resumeBody)
	}

	status, _, body = agentWorkItemRequest(t, env, http.MethodPost,
		"/internal/agents/"+acmeOfficialAgentManagementID+"/mcp-context/actions/resolve",
		teamHubInternalToken, "", map[string]any{
			"context": map[string]any{"kind": "document", "document_id": document.ID},
		})
	if status != http.StatusOK {
		t.Fatalf("mentioned Agent resolve Document MCP Context status=%d body=%s", status, body)
	}

	// The Agent reads and replies through the MCP comment tools, which share
	// these domain calls and pass no Room context.
	comments := documentservice.NewCommentService(env.pool, nil)
	if _, err := comments.GetThreadForAgent(t.Context(), acmeOfficialAgentManagementID, thread.ID); err != nil {
		t.Fatalf("mentioned Agent get Comment Thread: %v", err)
	}
	agentReply := func(key string, segments ...documentservice.Segment) (documentservice.Comment, error) {
		result, err := comments.ReplyForAgent(t.Context(), documentservice.AgentReplyInput{
			AgentManagementID: acmeOfficialAgentManagementID, ThreadID: thread.ID, IdempotencyKey: key,
			ParentCommentID: &thread.Comments[0].ID, Segments: segments,
		})
		return result.Comment, err
	}
	reply, err := agentReply("mention-agent-reply-"+suffix, documentservice.Segment{Type: "text", Content: "Mentioned Agent reply"})
	if err != nil || reply.ID == "" || reply.ThreadID != thread.ID || reply.Author.ID != "actor_acme_official" ||
		!strings.Contains(reply.Body, "Mentioned Agent reply") {
		t.Fatalf("mentioned Agent Comment reply=%+v err=%v", reply, err)
	}

	status, _, body = env.request(alice, http.MethodGet, "/v0/document-comment-threads/"+thread.ID, nil, "")
	if status != http.StatusOK {
		t.Fatalf("Human get thread after mentioned Agent reply status=%d body=%s", status, body)
	}
	var visible struct {
		ID       string `json:"id"`
		Comments []struct {
			ID     string `json:"id"`
			Body   string `json:"body"`
			Author struct {
				ID string `json:"id"`
			} `json:"author"`
		} `json:"comments"`
	}
	decode(t, body, &visible)
	if visible.ID != thread.ID || len(visible.Comments) != 2 {
		t.Fatalf("Human-visible thread after Agent reply=%+v", visible)
	}
	foundReply := false
	for _, comment := range visible.Comments {
		if comment.ID == reply.ID && comment.Author.ID == "actor_acme_official" &&
			strings.Contains(comment.Body, "Mentioned Agent reply") {
			foundReply = true
		}
	}
	if !foundReply {
		t.Fatalf("Human-visible thread missing mentioned Agent reply: %+v", visible.Comments)
	}

	if _, err := agentReply("mention-reply-mention-"+suffix,
		documentservice.Segment{Type: "reference", Content: "@alice", ActorID: "actor_acme_alice"},
		documentservice.Segment{Type: "text", Content: " here is the review"}); err != nil {
		t.Errorf("mentioned Agent reply mentioning sponsor must succeed: %v", err)
	}

	for _, target := range []string{"actor_acme_support"} {
		if _, err := agentReply("mention-denied-"+target+suffix,
			documentservice.Segment{Type: "reference", Content: "@unreadable", ActorID: target}); err == nil {
			t.Fatalf("Agent mentioned inaccessible target %s", target)
		}
	}
	worker := documentservice.NewCommentRunWorker(documentservice.New(env.pool))
	if _, err := worker.RunOne(t.Context()); err != nil {
		t.Fatal(err)
	}
	var independentStatus string
	if err := env.pool.QueryRow(t.Context(), `SELECT status FROM agent_local_runs WHERE run_id=$1`, localRunID).Scan(&independentStatus); err != nil {
		t.Fatal(err)
	}
	if independentStatus != "queued" {
		t.Fatalf("comment run worker canceled readable Agent work: %s", independentStatus)
	}
}

func TestEditingPlainDocumentCommentMentionsAgentWithoutSharing(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{revisionExport: true, jobPollInterval: 10 * time.Millisecond})
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	room := createPrivateRoom(t, env, alice, "Edit mention "+suffix, "edit-room-"+suffix)
	doc := createRoomDocumentForCommentRefs(t, env, alice, room, "Edit mention", "edit-doc-"+suffix)
	thread := createPlainDocumentCommentThread(t, env, alice, doc, room, suffix)
	id := thread.Comments[0].ID
	shares := func() int {
		return countRows(t, env, `SELECT count(*) FROM document_direct_collaborators WHERE document_id=$1`, doc.ID)
	}
	if got := shares(); got != 0 {
		t.Fatalf("new Document unexpectedly has %d shares", got)
	}
	status, _, body := env.request(alice, http.MethodPatch, "/v0/document-comments/"+id, map[string]any{
		"current_context":  map[string]any{"binding_kind": "room", "context_id": room},
		"expected_version": 1,
		"segments":         []map[string]any{{"type": "text", "content": "Please review "}, {"type": "reference", "content": "@official", "actor_id": "actor_acme_official"}},
		"durable_head":     durableHeadPayload(doc.DurableHead.PersistedSeq, doc.DurableHead.StateHash, doc.DurableHead.StateHashVersion),
	}, "edit-first-mention-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("edit first mention: %d %s", status, body)
	}
	run := waitForDocumentCommentRun(t, env, id)
	if run == "" || shares() != 0 {
		t.Fatalf("edit must queue work without sharing; run=%q shares=%d", run, shares())
	}
}

// createPlainDocumentCommentThread opens a Comment thread that mentions nobody,
// so no Agent dispatch runs beside the write under test.
func createPlainDocumentCommentThread(
	t *testing.T,
	env *testEnv,
	alice *http.Client,
	document roomDocumentResponse,
	roomID, suffix string,
) roomDocumentCommentThreadResponse {
	t.Helper()
	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/comment-threads", map[string]any{
		"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
		"anchor": map[string]any{
			"quoted_text": "selected text", "block_id": "block_document_" + suffix,
			"context_before": "before", "context_after": "after",
		},
		"initial_comment": map[string]any{"segments": []map[string]any{
			{"type": "text", "content": "Please revise this."},
		}},
		"durable_head": durableHeadPayload(
			document.DurableHead.PersistedSeq, document.DurableHead.StateHash, document.DurableHead.StateHashVersion,
		),
	}, "document-comment-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Comment thread status=%d body=%s", status, body)
	}
	var thread roomDocumentCommentThreadResponse
	decode(t, body, &thread)
	return thread
}

func addDocumentAgentToRoom(t *testing.T, env *testEnv, alice *http.Client, roomID, idempotencyKey string) {
	t.Helper()
	status, _, body := env.request(alice, http.MethodPut,
		"/v0/rooms/"+roomID+"/members/actor_acme_official", map[string]any{"role": "member"}, idempotencyKey)
	if status != http.StatusOK {
		t.Fatalf("add Document Agent member status=%d body=%s", status, body)
	}
}

func durableHeadPayload(persistedSeq int64, stateHash string, version int) map[string]any {
	return map[string]any{
		"persisted_seq": persistedSeq, "state_hash": stateHash, "state_hash_version": version,
	}
}

func attachDocumentAgentThread(
	t *testing.T,
	env *testEnv,
	alice *http.Client,
	documentID, threadID, suffix string,
) (int64, string) {
	t.Helper()
	credential := openRoomDocumentSessionForCommentRefs(t, env, alice, documentID, "document_agent_runtime_"+suffix)
	if check := validateCommentThreadRefs(t, env, documentID, []string{threadID}); check != "available" {
		t.Fatalf("validate Document Agent Thread ref: %s", check)
	}
	return 1, appendCommentThreadRefs(t, env, documentID, credential.claims(t).ActorID,
		"attach_document_agent_batch_"+suffix, 0, []string{threadID})
}

// waitForDocumentCommentRun returns the Local Run whose initial Runtime input
// was triggered by the comment.
func waitForDocumentCommentRun(t *testing.T, env *testEnv, commentID string) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var runID string
		err := env.pool.QueryRow(t.Context(), `SELECT run_input.run_id
			FROM agent_runtime_inputs input
			JOIN agent_local_run_inputs run_input
			  ON run_input.context_key=input.context_key AND run_input.input_id=input.input_id
			 AND run_input.relation='initial'
			WHERE input.source_kind='inbox' AND input.source_message_id=$1`, commentID).Scan(&runID)
		if err == nil {
			return runID
		}
		if !errors.Is(err, pgx.ErrNoRows) || time.Now().After(deadline) {
			t.Fatalf("wait for Document Comment Run: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func documentCommentRunContextKey(t *testing.T, env *testEnv, runID string) string {
	t.Helper()
	var contextKey string
	if err := env.pool.QueryRow(t.Context(), `SELECT context_key FROM agent_local_runs WHERE run_id=$1`,
		runID).Scan(&contextKey); err != nil {
		t.Fatal(err)
	}
	return contextKey
}

// waitForDocumentCommentRunQueued waits until the comment Run is queued and
// its Document Context has wantResidency: suspended while the anchor is
// pending, active once the Run was admitted.
func waitForDocumentCommentRunQueued(t *testing.T, env *testEnv, runID, wantResidency string) {
	t.Helper()
	waitForDocumentCommentRunState(t, env, runID, "queued", wantResidency)
}

// waitForDocumentCommentRunFailed waits until the comment Run failed with
// document_input_failed.
func waitForDocumentCommentRunFailed(t *testing.T, env *testEnv, runID string) {
	t.Helper()
	waitForDocumentCommentRunState(t, env, runID, "failed", "")
}

func waitForDocumentCommentRunState(t *testing.T, env *testEnv, runID, wantRunStatus, wantResidency string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var residency, runStatus, terminalError string
		err := env.pool.QueryRow(t.Context(), `SELECT execution_context.target_residency,local_run.status,
				coalesce(local_run.terminal->>'error','')
			FROM agent_local_runs local_run
			JOIN agent_execution_contexts execution_context
			  ON execution_context.context_key=local_run.context_key
			WHERE local_run.run_id=$1`, runID).Scan(&residency, &runStatus, &terminalError)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		if err == nil && runStatus == wantRunStatus &&
			(wantRunStatus != "failed" || terminalError == "document_input_failed") &&
			(wantResidency == "" || residency == wantResidency) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Document comment Run=%q residency=%q terminal=%q want=%q/%q err=%v",
				runStatus, residency, terminalError, wantRunStatus, wantResidency, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
