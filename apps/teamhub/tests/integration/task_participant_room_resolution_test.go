package integration_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
)

func TestAgentParticipantTaskResolutionUsesFrozenGenerationNotAssignment(t *testing.T) {
	serialIntegrationTest(t, serialProcessLogger)
	var applicationLogs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&applicationLogs, &slog.HandlerOptions{Level: slog.LevelError})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)

	nonParticipantActorID := "actor_participant_resolver_other_" + suffix
	nonParticipantAgentID := "agent-management-participant-resolver-other-" + suffix
	if _, err := env.pool.Exec(t.Context(), `
		insert into actors(id,tenant_id,kind,display_name,handle)
		values($1,$2,'agent','Nonparticipant resolver Agent',$3)`,
		nonParticipantActorID, acmeTenant, "resolver-other-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		insert into agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) values($1,$2,$3,'active','Test participant-scoped Task resolution.','gpt-5','actor_acme_alice','computer_fixture','codex','grant_files')`,
		nonParticipantActorID, acmeTenant, nonParticipantAgentID); err != nil {
		t.Fatal(err)
	}

	taskID, taskRoomID := createParticipantResolutionTask(t, env, suffix)
	resolvePath := func(agentID, roomID string) string {
		return "/v0/agents/" + agentID + "/participant-task:resolve?work_room_id=" + roomID
	}

	status, _, body := agentWorkItemRequest(t, env, http.MethodGet,
		resolvePath(acmeOfficialAgentManagementID, taskRoomID), teamHubInternalToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("resolve frozen participant Task status=%d body=%s", status, body)
	}
	var resolved struct {
		TaskID              string `json:"task_id"`
		WorkRoomID          string `json:"work_room_id"`
		ExecutionGeneration int64  `json:"execution_generation"`
	}
	decode(t, body, &resolved)
	if resolved.TaskID != taskID || resolved.WorkRoomID != taskRoomID || resolved.ExecutionGeneration != 1 {
		t.Fatalf("participant Task resolution=%+v", resolved)
	}

	status, _, body = env.request(alice, http.MethodPut,
		"/v0/work-items/"+taskID+"/assignments/"+nonParticipantActorID, nil,
		"participant-resolver-assign-other-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("assign nonparticipant status=%d body=%s", status, body)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodGet,
		resolvePath(nonParticipantAgentID, taskRoomID), teamHubInternalToken, "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("mutable assignment granted Task participant resolution status=%d body=%s", status, body)
	}

	status, _, body = env.request(alice, http.MethodDelete,
		"/v0/work-items/"+taskID+"/assignments/actor_acme_official", nil,
		"participant-resolver-unassign-frozen-"+suffix)
	if status != http.StatusNoContent {
		t.Fatalf("unassign frozen participant status=%d body=%s", status, body)
	}
	status, _, body = agentWorkItemRequest(t, env, http.MethodGet,
		resolvePath(acmeOfficialAgentManagementID, taskRoomID), teamHubInternalToken, "", nil)
	if status != http.StatusOK {
		t.Fatalf("unassignment revoked frozen participant resolution status=%d body=%s", status, body)
	}

	status, _, body = agentWorkItemRequest(t, env, http.MethodGet,
		resolvePath("agent-management-other-official", taskRoomID), teamHubInternalToken, "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross-Tenant Agent resolved Task status=%d body=%s", status, body)
	}
}

func createParticipantResolutionTask(t *testing.T, env *testEnv, suffix string) (string, string) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	creator, err := queries.GetActor(t.Context(), store.GetActorParams{
		ID: "actor_acme_official", TenantID: acmeTenant,
	})
	if err != nil {
		t.Fatal(err)
	}
	sponsor, err := queries.GetActor(t.Context(), store.GetActorParams{
		ID: "actor_acme_alice", TenantID: acmeTenant,
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := workitem.CreateTaskForApprovedCreation(t.Context(), tx, queries, creator, workitem.CreateInput{
		Kind: "task", Title: "Participant resolver " + suffix, Priority: "medium",
		AssigneeActorIDs: []string{"actor_acme_official"},
	})
	if err != nil {
		t.Fatal(err)
	}
	createdRoom, err := roomcreation.Create(t.Context(), queries, roomcreation.Spec{
		TenantID: acmeTenant, Name: "Participant resolver Task Room " + suffix,
		Creator: creator, Owner: sponsor, AgentsAuthorized: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queries.CreateWorkItemRoomLink(t.Context(), store.CreateWorkItemRoomLinkParams{
		WorkItemID: item.ID, TenantID: acmeTenant, LinkType: "work", RoomID: createdRoom.Room.ID,
		OriginMessageID: pgtype.Text{}, LinkedByActorID: creator.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := taskexecution.CreateManagedGeneration(t.Context(), tx, queries, taskexecution.CreateManagedGenerationInput{
		TaskID: item.ID, TenantID: acmeTenant, EventRoomID: createdRoom.Room.ID,
		WorkItemVersion: item.Version,
		SourceKey:       "participant-resolver:" + suffix,
		RunSpec: taskexecution.RunSpecV1{
			SchemaVersion: 1, ResultAgentActorID: "actor_acme_official",
			AttemptPolicy: taskexecution.DelegatedAttemptPolicyV1(),
		},
		Participant: taskexecution.ParticipantInput{
			ActorID: "actor_acme_official", AgentManagementID: acmeOfficialAgentManagementID,
			ExecutionContextRef: mustJSON(t, map[string]any{
				"kind": "alter_ego", "agentId": acmeOfficialAgentManagementID, "taskId": item.ID,
			}),
		},
		InitialInputManifest: json.RawMessage(`{"source":"participant-room-resolution"}`),
		InitialMessage: taskexecution.TurnMessageInput{
			MessageID:  "participant-resolver-message-" + suffix,
			RawMessage: "Resolve only the frozen participant.",
			Segments:   json.RawMessage(`[{"type":"text","content":"Resolve only the frozen participant."}]`),
			Author: &taskexecution.TurnMessageAuthor{
				ActorID: "actor_acme_alice", Kind: "human", DisplayName: "Alice",
			},
		},
		CausedByActorID: "actor_acme_alice",
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return item.ID, createdRoom.Room.ID
}
