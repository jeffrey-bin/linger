package integration_test

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestSponsorDeletesTenantAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "Disposable Reviewer", "instructions": "Review once.",
		"runtime": fixtureRuntime("gpt-5"),
	}, "delete-agent-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent status=%d body=%s", status, body)
	}
	var agent struct {
		AgentManagementID string `json:"agent_management_id"`
		Actor             struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &agent)

	roomID := createPrivateRoom(t, env, alice, "Agent deletion "+suffix, "agent-deletion-room-"+suffix)
	if memberStatus, memberBody := putRoomMember(t, env, alice, roomID, agent.Actor.ID, "member"); memberStatus != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", memberStatus, memberBody)
	}
	historyMessageID := seedAgentMessage(t, env, roomID, agent.Actor.ID, "Keep this reply after Agent deletion.")

	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, nil, "")
	if status != http.StatusNoContent || len(body) != 0 {
		t.Fatalf("delete Agent status=%d body=%s", status, body)
	}
	if deleted := agentManagement.notifiedSnapshot(); len(deleted) != 1 || deleted[0] != agent.AgentManagementID {
		t.Fatalf("upstream deletions=%v", deleted)
	}
	if got := countRows(t, env, "select count(*) from room_members where actor_id=$1", agent.Actor.ID); got != 0 {
		t.Fatalf("Agent memberships after delete=%d", got)
	}
	if got := countRows(t, env, "select count(*) from room_events where room_id=$1 and event_type='room.member.removed' and resource_id=$2", roomID, agent.Actor.ID); got != 1 {
		t.Fatalf("Agent removal events=%d", got)
	}

	status, _, agents := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?limit=200", nil, "")
	if status != http.StatusOK || containsJSONText(agents, agent.Actor.ID) {
		t.Fatalf("deleted Agent remained in directory status=%d body=%s", status, agents)
	}
	status, _, actors := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/actors?limit=200", nil, "")
	if status != http.StatusOK || containsJSONText(actors, agent.Actor.ID) {
		t.Fatalf("deleted Agent remained in Actor directory status=%d body=%s", status, actors)
	}
	for _, path := range []string{
		"/v0/rooms/" + roomID + "/messages?limit=200",
		"/v0/rooms/" + roomID + "/messages/" + historyMessageID,
	} {
		status, _, history := env.request(alice, http.MethodGet, path, nil, "")
		if status != http.StatusOK || !containsJSONText(history, historyMessageID) || !containsJSONText(history, agent.Actor.ID) {
			t.Fatalf("deleted Agent history path=%s status=%d body=%s", path, status, history)
		}
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, nil, "")
	if status != http.StatusNoContent || len(agentManagement.notifiedSnapshot()) != 1 {
		t.Fatalf("delete replay status=%d body=%s upstream=%v", status, body, agentManagement.notifiedSnapshot())
	}
}

func TestAgentDeletionPreservesOwnedDocumentsBeforeRevocation(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "Document Owner " + suffix, "instructions": "Own one durable document.",
		"runtime": fixtureRuntime("gpt-5"),
	}, "create-document-owner-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent status=%d body=%s", status, body)
	}
	var agent struct {
		AgentManagementID string `json:"agent_management_id"`
		Actor             struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &agent)
	documentID := "document_agent_deletion_" + suffix
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,'Retained document','plain_text',$3,'agent',$3,'agent','active')`,
		documentID, acmeTenant, agent.Actor.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO work_items(
		id,tenant_id,number,kind,title,description,priority,created_by_actor_id,updated_by_actor_id
	) SELECT 'work_item_agent_deletion',$1,coalesce(max(number),0)+1,'issue',
		'Agent deletion authority','Agent deletion authority','medium',$2,$2
	FROM work_items WHERE tenant_id=$1`, acmeTenant, "actor_acme_alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO work_item_assignments(
		work_item_id,tenant_id,actor_id,assigned_by_actor_id
	) VALUES('work_item_agent_deletion',$1,$2,'actor_acme_alice')`, acmeTenant, agent.Actor.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
		) VALUES($1,$2,$3,0,'\x00',repeat('c',64),'\x00',repeat('c',64),'[]'::jsonb,$4)`,
		"revision_agent_deletion_"+suffix, acmeTenant, documentID, agent.Actor.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ($1,$2,0,'\x00',repeat('c',64),$3,$4)) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id`, documentID, acmeTenant,
		"revision_agent_deletion_"+suffix, agent.Actor.ID); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, nil, "")
	if status != http.StatusNoContent || len(body) != 0 {
		var registrationStatus, documentOwner string
		_ = env.pool.QueryRow(t.Context(), `SELECT status FROM agent_registrations WHERE actor_id=$1`,
			agent.Actor.ID).Scan(&registrationStatus)
		_ = env.pool.QueryRow(t.Context(), `SELECT owner_actor_id FROM documents WHERE id=$1`,
			documentID).Scan(&documentOwner)
		t.Fatalf("delete Agent status=%d body=%s registration=%s owner=%s upstream=%v",
			status, body, registrationStatus, documentOwner, agentManagement.notifiedSnapshot())
	}
	var ownerActorID, ownerKind, creatorActorID, creatorKind string
	if err := env.pool.QueryRow(t.Context(), `SELECT owner_actor_id,owner_actor_kind,
		creator_actor_id,creator_actor_kind
		FROM documents WHERE id=$1`, documentID).Scan(
		&ownerActorID, &ownerKind, &creatorActorID, &creatorKind,
	); err != nil {
		t.Fatal(err)
	}
	if ownerActorID != agent.Actor.ID || ownerKind != "agent" || creatorActorID != agent.Actor.ID || creatorKind != "agent" {
		t.Fatalf("owner=%s/%s creator=%s/%s", ownerActorID, ownerKind, creatorActorID, creatorKind)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_registrations
		WHERE actor_id=$1 AND status='revoked'`, agent.Actor.ID); got != 1 {
		t.Fatalf("revoked registrations=%d", got)
	}
	if deleted := agentManagement.notifiedSnapshot(); len(deleted) != 1 || deleted[0] != agent.AgentManagementID {
		t.Fatalf("upstream deletions=%v", deleted)
	}

	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, nil, "")
	if status != http.StatusNoContent || len(body) != 0 {
		t.Fatalf("delete replay status=%d body=%s", status, body)
	}
}

func TestAgentDeletionPreservesAllOwnedDocumentsBeforeExternalDeletion(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	status, _, body := env.request(alice, http.MethodPost,
		"/v0/tenants/"+acmeTenant+"/agents", map[string]any{
			"name": "Batch Transfer Agent", "instructions": "Transfer every owned Document.",
			"runtime": fixtureRuntime("gpt-5"),
		}, "agent-deletion-batches-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create batch Agent status=%d body=%s", status, body)
	}
	var agent struct {
		AgentManagementID string `json:"agent_management_id"`
		Actor             struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &agent)
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) SELECT $1 || series::text,$2,'Batch document ' || series::text,'plain_text',
		$3,'agent',$3,'agent','active'
	FROM generate_series(1,101) series`,
		"document_agent_deletion_batch_"+suffix+"_", acmeTenant, agent.Actor.ID); err != nil {
		t.Fatal(err)
	}

	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, nil, "")
	if status != http.StatusNoContent || len(body) != 0 {
		t.Fatalf("batch Agent deletion status=%d body=%s", status, body)
	}
	if got := countRows(t, env, `SELECT count(*) FROM documents
		WHERE creator_actor_id=$1 AND owner_actor_id=$1 AND owner_actor_kind='agent'`, agent.Actor.ID); got != 101 {
		t.Fatalf("retained batch Documents=%d", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM agent_registrations
		WHERE actor_id=$1 AND status='revoked'`, agent.Actor.ID); got != 1 {
		t.Fatalf("batch Agent revoked registrations=%d", got)
	}
	if deleted := agentManagement.notifiedSnapshot(); len(deleted) != 1 || deleted[0] != agent.AgentManagementID {
		t.Fatalf("batch Agent upstream deletions=%v", deleted)
	}
}

// Deletion commits in TeamHub; an unreachable Agent Service only misses the
// wake-up and removes the Runner when it next reads the registration.
func TestAgentDeletionDoesNotWaitForAgentService(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{notifyErr: errors.New("Agent Service is unreachable")}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	if _, err := env.pool.Exec(t.Context(), `UPDATE local_computers SET status='offline',last_seen_at=now()-interval '1 hour' WHERE computer_id=$1`, fixtureComputerID); err != nil {
		t.Fatal(err)
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "Offline Deletion", "instructions": "Never reaches the Computer.",
		"runtime": fixtureRuntime("gpt-5"),
	}, "offline-delete-agent-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent status=%d body=%s", status, body)
	}
	var agent struct {
		AgentManagementID string `json:"agent_management_id"`
		Actor             struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &agent)

	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, nil, "")
	if status != http.StatusNoContent || len(body) != 0 {
		t.Fatalf("delete status=%d body=%s", status, body)
	}
	if got := countRows(t, env, "select count(*) from agent_registrations where actor_id=$1 and status='revoked'", agent.Actor.ID); got != 1 {
		t.Fatalf("revoked registrations=%d want=1", got)
	}
	if notified := agentManagement.notifiedSnapshot(); len(notified) != 1 || notified[0] != agent.AgentManagementID {
		t.Fatalf("notified=%v", notified)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, nil, "")
	if status != http.StatusNoContent || len(agentManagement.notifiedSnapshot()) != 1 {
		t.Fatalf("delete replay status=%d body=%s notified=%v", status, body, agentManagement.notifiedSnapshot())
	}
}

func TestAgentDeletionWaitsForPendingCardDecision(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Agent deletion approval "+suffix, "agent-deletion-approval-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent status=%d body=%s", status, body)
	}
	requestID := createPendingRoomCreationApproval(t, env, roomID, suffix)

	status, _, body := env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/actor_acme_official", nil, "")
	if status != http.StatusConflict || !containsJSONText(body, "PENDING_CARD_DECISION") {
		t.Fatalf("delete Agent with a pending approval status=%d body=%s", status, body)
	}
	if deleted := agentManagement.notifiedSnapshot(); len(deleted) != 0 {
		t.Fatalf("pending approval called upstream deletion: %v", deleted)
	}
	if got := countRows(t, env, "select count(*) from agent_registrations where actor_id='actor_acme_official' and status='active'"); got != 1 {
		t.Fatalf("active Agent registrations=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from room_members where room_id=$1 and actor_id='actor_acme_official'", roomID); got != 1 {
		t.Fatalf("protected Agent memberships=%d want=1", got)
	}

	denyRoomCreationApproval(t, env, alice, requestID, suffix)
	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/agents/actor_acme_official", nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("delete Agent after the decision status=%d body=%s", status, body)
	}
	if deleted := agentManagement.notifiedSnapshot(); len(deleted) != 1 || deleted[0] != acmeOfficialAgentManagementID {
		t.Fatalf("decided approval upstream deletions=%v", deleted)
	}
	if got := countRows(t, env, "select count(*) from agent_registrations where actor_id='actor_acme_official' and status='revoked'"); got != 1 {
		t.Fatalf("revoked Agent registrations=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from room_members where room_id=$1 and actor_id='actor_acme_official'", roomID); got != 0 {
		t.Fatalf("Agent memberships after deletion=%d want=0", got)
	}
}

func TestAgentDeletionSerializesWithConcurrentRoomAdmission(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{
		"name": "Concurrent Admission Agent", "instructions": "Join one Room.",
		"runtime": fixtureRuntime("gpt-5"),
	}, "concurrent-admission-agent-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Agent status=%d body=%s", status, body)
	}
	var agent struct {
		Actor struct {
			ID string `json:"id"`
		} `json:"actor"`
	}
	decode(t, body, &agent)

	roomID := createPrivateRoom(t, env, alice, "Concurrent admission "+suffix, "concurrent-admission-room-"+suffix)
	blocker, err := env.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(context.Background(), "LOCK TABLE room_events IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}

	results := make(chan asyncHTTPResult, 2)
	if err := startAsyncJSONRequest(results, "admit", alice, http.MethodPut,
		env.server.URL+"/v0/rooms/"+roomID+"/members/"+agent.Actor.ID, "",
		map[string]any{"role": "member"}); err != nil {
		t.Fatal(err)
	}
	waitForBlockedQuery(t, env, "INSERT INTO room_events")
	if err := startAsyncJSONRequest(results, "delete", alice, http.MethodDelete,
		env.server.URL+"/v0/tenants/"+acmeTenant+"/agents/"+agent.Actor.ID, "", nil); err != nil {
		t.Fatal(err)
	}
	waitForBlockedQuery(t, env, "pg_advisory_xact_lock")
	select {
	case result := <-results:
		t.Fatalf("%s completed with status %d before admission released its Agent lock", result.name, result.status)
	default:
	}

	if err := blocker.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	statuses := map[string]int{}
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		statuses[result.name] = result.status
	}
	if statuses["admit"] != http.StatusOK || statuses["delete"] != http.StatusNoContent {
		t.Fatalf("concurrent admission statuses=%v", statuses)
	}
	if got := countRows(t, env, "select count(*) from agent_registrations where actor_id=$1 and status='revoked'", agent.Actor.ID); got != 1 {
		t.Fatalf("revoked Agent registrations=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from room_members where room_id=$1 and actor_id=$2", roomID, agent.Actor.ID); got != 0 {
		t.Fatalf("Agent memberships after deletion=%d want=0", got)
	}
	t.Run("Inbox writers release their locks when Agent deletion fences identity", func(t *testing.T) {
		for _, directRoom := range []bool{false, true} {
			name := "Inbox cursor commit"
			if directRoom {
				name = "Direct Room Inbox cursor commit"
			}
			t.Run(name, func(t *testing.T) {
				management := &recordingAgentManagement{}
				env, alice := newAgentRegistrationEnv(t, management)
				seedReadyFixtureComputers(t, env.pool)
				roomID := createPrivateRoom(t, env, alice, "Deletion reception", "deletion-reception-room")
				if directRoom {
					direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
					if direct.status != http.StatusCreated {
						t.Fatalf("open Direct Room: %+v", direct)
					}
					roomID = direct.roomID
				} else if httpStatus, responseBody := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); httpStatus != http.StatusOK {
					t.Fatalf("add Agent: %d %s", httpStatus, responseBody)
				}
				runtime := agentruntimestate.New(env.pool)
				ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: testRuntimeAgentID, RoomID: roomID}, TargetResidency: "active"})
				if err != nil {
					t.Fatal(err)
				}
				startRuntimeEpoch(t, runtime, "deletion-reception-agent")
				fence := "deletion-reception-agent"
				inboxID := "room:" + roomID
				ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
				defer cancel()
				barrier := &agentDeletionWriterBarrier{held: make(chan int32, 1), release: make(chan struct{})}
				release := sync.OnceFunc(func() { close(barrier.release) })
				defer release()
				writerDone := make(chan error, 1)
				barrier.prefix = "-- name: LockDirectInboxMembershipAuthority "
				poolConfig := env.pool.Config()
				poolConfig.ConnConfig.Tracer = barrier
				writerPool, err := pgxpool.NewWithConfig(t.Context(), poolConfig)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(writerPool.Close)
				go func() {
					_, err := agentruntimestate.New(writerPool).SubmitTrustedTurn(ctx, agentruntimestate.SubmitTrustedTurnInput{ContextKey: ensured.Context.ContextKey, Epoch: fence, Inputs: []agentruntimestate.RuntimeInput{runtimeInput("during-deletion", "trusted_turn", inboxID, "racing")}})
					writerDone <- err
				}()
				var writerPID int32
				select {
				case writerPID = <-barrier.held:
				case err := <-writerDone:
					t.Fatalf("writer finished before locking membership: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				deletionDone := make(chan asyncHTTPResult, 1)
				requestPath := env.server.URL + "/v0/tenants/" + acmeTenant + "/agents/actor_acme_official"
				if err := startAsyncJSONRequest(deletionDone, "delete", alice, http.MethodDelete, requestPath, "", nil); err != nil {
					t.Fatal(err)
				}
				// Deletion revokes the identity first in its transaction, which then
				// waits for this writer to release the membership authority.
				for {
					var waiting bool
					if err := env.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND position('GetRoomMemberForUpdate' in query)>0 AND $1=ANY(pg_blocking_pids(pid)))`, writerPID).Scan(&waiting); err != nil {
						t.Fatal(err)
					}
					if waiting {
						break
					}
					select {
					case result := <-deletionDone:
						t.Fatalf("deletion bypassed held membership: %+v", result)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-time.After(10 * time.Millisecond):
					}
				}
				release()
				select {
				case err := <-writerDone:
					// The writer holds the membership first, so it commits before the deletion.
					if err != nil {
						t.Fatalf("writer ordered before the deletion: %v", err)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				select {
				case result := <-deletionDone:
					if result.err != nil || result.status != http.StatusNoContent {
						t.Fatalf("deletion after writer: %+v", result)
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if got := countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id='actor_acme_official' AND status='revoked'`); got != 1 {
					t.Fatal("Agent revocation did not commit")
				}
				if _, err := runtime.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: ensured.Context.ContextKey, Epoch: fence, Inputs: []agentruntimestate.RuntimeInput{runtimeInput("after-deletion", "trusted_turn", inboxID, "denied")}}); !errors.Is(err, agentruntimestate.ErrFenced) {
					t.Fatalf("deleted Agent still accepts Input: %v", err)
				}
				const healthyAgent = "agent-deletion-healthy"
				insertRuntimeRegistrationFixture(t, env.pool, healthyAgent, "active")
				seedReadyFixtureComputers(t, env.pool)
				insertRuntimeRoomMembershipForAgent(t, env.pool, "room_deletion_healthy", "actor-"+healthyAgent)
				healthy, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: healthyAgent, RoomID: "room_deletion_healthy"}, TargetResidency: "active"})
				if err != nil {
					t.Fatal(err)
				}
				startRuntimeEpoch(t, runtime, "healthy-deletion-agent")
				createHumanMessage(t, env, alice, "room_deletion_healthy", "Unrelated reception remains available", "deletion-healthy-message")
				if _, submitErr := runtime.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{ContextKey: healthy.Context.ContextKey, Epoch: "healthy-deletion-agent", Inputs: []agentruntimestate.RuntimeInput{runtimeInput("deletion-healthy", "trusted_turn", "room:room_deletion_healthy", "still here")}}); submitErr != nil {
					t.Fatalf("unrelated Agent lost input reception: %v", submitErr)
				}
			})
		}
	})
}

// Opening a new direct Room admits its Agent, so it takes the Tenant
// membership lock first, as Agent deletion does: a deletion racing the first
// open waits for the Room, then deletes it with the Agent.
func TestAgentDeletionSerializesWithConcurrentDirectRoomCreation(t *testing.T) {
	allowParallelIntegrationTest(t)
	agentManagement := &recordingAgentManagement{}
	env, alice := newAgentRegistrationEnv(t, agentManagement)
	blocker, err := env.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(context.Background(), "LOCK TABLE room_events IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}

	results := make(chan asyncHTTPResult, 2)
	if err := startAsyncJSONRequest(results, "open", alice, http.MethodPost,
		env.server.URL+"/v0/tenants/"+acmeTenant+"/direct-rooms", "",
		map[string]any{"peer_actor_id": "actor_acme_official"}); err != nil {
		t.Fatal(err)
	}
	waitForBlockedQuery(t, env, "INSERT INTO room_events")
	if err := startAsyncJSONRequest(results, "delete", alice, http.MethodDelete,
		env.server.URL+"/v0/tenants/"+acmeTenant+"/agents/actor_acme_official", "", nil); err != nil {
		t.Fatal(err)
	}
	waitForBlockedQuery(t, env, "pg_advisory_xact_lock")
	select {
	case result := <-results:
		t.Fatalf("%s completed with status %d before the direct Room committed", result.name, result.status)
	default:
	}
	if err := blocker.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	responses := map[string]asyncHTTPResult{}
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		responses[result.name] = result
	}
	if responses["open"].status != http.StatusCreated ||
		responses["delete"].status != http.StatusNoContent {
		t.Fatalf("open=%d delete=%d", responses["open"].status, responses["delete"].status)
	}
	var room struct {
		ID string `json:"id"`
	}
	decode(t, responses["open"].body, &room)
	if got := countRows(t, env, "select count(*) from agent_registrations where actor_id='actor_acme_official' and status='revoked'"); got != 1 {
		t.Fatalf("revoked Agent registrations=%d want=1", got)
	}
	if got := countRows(t, env, "select count(*) from rooms where id=$1 and deletion_started_at is not null", room.ID); got != 1 {
		t.Fatal("the direct Room opened during the deletion was left behind")
	}
}

type agentDeletionWriterBarrier struct {
	prefix  string
	held    chan int32
	release chan struct{}
	mu      sync.Mutex
	armed   bool
}

type agentDeletionWriterQueryKey struct{}

func (barrier *agentDeletionWriterBarrier) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !strings.HasPrefix(data.SQL, barrier.prefix) {
		return ctx
	}
	barrier.mu.Lock()
	first := !barrier.armed
	barrier.armed = true
	barrier.mu.Unlock()
	if first {
		return context.WithValue(ctx, agentDeletionWriterQueryKey{}, connection.PgConn().PID())
	}
	return ctx
}

func (barrier *agentDeletionWriterBarrier) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if pid, held := ctx.Value(agentDeletionWriterQueryKey{}).(uint32); held && data.Err == nil {
		barrier.held <- int32(pid)
		select {
		case <-barrier.release:
		case <-ctx.Done():
		}
	}
}
