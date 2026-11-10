package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
)

type taskWorkerHTTPBundle struct {
	Lease *struct {
		TaskID          string    `json:"task_id"`
		WorkerID        string    `json:"worker_id"`
		LeaseToken      string    `json:"lease_token"`
		LeaseGeneration int64     `json:"lease_generation"`
		LeaseExpiresAt  time.Time `json:"lease_expires_at"`
	} `json:"lease"`
	Execution struct {
		TaskID                 string `json:"task_id"`
		Generation             int64  `json:"generation"`
		Status                 string `json:"status"`
		ExecutionRevision      int64  `json:"execution_revision"`
		DesiredControl         string `json:"desired_control"`
		ControlRevision        int64  `json:"control_revision"`
		ControlSettledRevision int64  `json:"control_settled_revision"`
		CurrentAttempt         *struct {
			ID                   string     `json:"id"`
			AttemptNumber        int64      `json:"attempt_number"`
			Status               string     `json:"status"`
			CurrentInputRevision int64      `json:"current_input_revision"`
			DeadlineAt           *time.Time `json:"deadline_at"`
			StopReasonCode       *string    `json:"stop_reason_code"`
		} `json:"current_attempt"`
		Effects []struct {
			ID          string         `json:"id"`
			Operation   string         `json:"operation"`
			Status      string         `json:"status"`
			Payload     map[string]any `json:"payload"`
			Observation map[string]any `json:"observation"`
		} `json:"pending_effects"`
		Facts []struct {
			Kind string `json:"fact_kind"`
		} `json:"execution_facts"`
	} `json:"execution"`
}

type managedTaskFixture struct {
	ID                string
	Version           int64
	InitialCapability string
}

// createManagedTaskFixture creates a Task whose only participant is the
// official Agent's AlterEgo.
func createManagedTaskFixture(t *testing.T, env *testEnv, roomID, suffix string) managedTaskFixture {
	t.Helper()
	initialMessage := taskexecution.TurnMessageInput{
		MessageID: "task-message-" + suffix, RawMessage: "Return a summary.",
		Segments: json.RawMessage(`[{"type":"text","content":"Return a summary."}]`),
		Author: &taskexecution.TurnMessageAuthor{
			ActorID: "actor_acme_alice", Kind: "human", DisplayName: "Alice",
		},
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatalf("begin managed Task fixture: %v", err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	creator, err := queries.GetActor(t.Context(), store.GetActorParams{ID: "actor_acme_official", TenantID: acmeTenant})
	if err != nil {
		t.Fatalf("load managed Task creator: %v", err)
	}
	item, err := workitem.CreateTaskForApprovedCreation(t.Context(), tx, queries, creator, workitem.CreateInput{
		Kind: "task", Title: "Schema Task " + suffix, Priority: "medium",
		Description:      initialMessage.RawMessage,
		AssigneeActorIDs: []string{"actor_acme_official"}, OriginRoomID: roomID,
	})
	if err != nil {
		t.Fatalf("create approved managed Task fixture: %v", err)
	}
	managed, err := taskexecution.CreateManagedGeneration(t.Context(), tx, queries, taskexecution.CreateManagedGenerationInput{
		TaskID: item.ID, TenantID: acmeTenant, EventRoomID: roomID, WorkItemVersion: item.Version,
		SourceKey:       "task_creation:integration:" + suffix,
		CausedByActorID: "actor_acme_alice",
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
		InitialInputManifest: json.RawMessage(`{"source":"integration"}`),
		InitialMessage:       initialMessage,
	})
	if err != nil {
		t.Fatalf("create managed Task execution: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit managed Task fixture: %v", err)
	}
	return managedTaskFixture{ID: item.ID, Version: item.Version, InitialCapability: managed.InitialCapability}
}

func transitionTaskWorker(
	t *testing.T,
	env *testEnv,
	bundle taskWorkerHTTPBundle,
	workerID, leaseToken string,
	leaseGeneration int64,
	transition string,
	payload map[string]any,
) taskWorkerHTTPBundle {
	t.Helper()
	status, _, body := taskWorkerJSONRequest(t, env, http.MethodPost,
		"/v0/task-executions/"+bundle.Execution.TaskID+"/transitions", teamHubInternalToken, map[string]any{
			"worker_id": workerID, "lease_generation": leaseGeneration,
			"execution_generation":        bundle.Execution.Generation,
			"expected_execution_revision": bundle.Execution.ExecutionRevision,
			"expected_control_revision":   bundle.Execution.ControlRevision,
			"transition":                  transition, "operation_id": "integration-" + transition +
				"-r" + strconv.FormatInt(bundle.Execution.ExecutionRevision, 10),
			"payload": payload,
		}, taskLeaseHeader(leaseToken))
	if status != http.StatusOK {
		t.Fatalf("Task transition %s status=%d body=%s", transition, status, body)
	}
	var result taskWorkerHTTPBundle
	decode(t, body, &result)
	return result
}

func claimTaskWorker(t *testing.T, env *testEnv, workerID string) taskWorkerHTTPBundle {
	t.Helper()
	status, _, body := taskWorkerJSONRequest(t, env, http.MethodPost, "/v0/task-execution-claims",
		teamHubInternalToken, map[string]any{"worker_id": workerID, "lease_seconds": 60})
	if status != http.StatusOK {
		t.Fatalf("claim Task worker %s status=%d body=%s", workerID, status, body)
	}
	var bundle taskWorkerHTTPBundle
	decode(t, body, &bundle)
	if bundle.Lease == nil {
		t.Fatalf("claim Task worker %s returned no execution", workerID)
	}
	return bundle
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func taskWorkerJSONRequest(
	t *testing.T,
	env *testEnv,
	method, path, bearer string,
	payload any,
	extraHeaders ...http.Header,
) (int, http.Header, []byte) {
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
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	for _, headers := range extraHeaders {
		for name, values := range headers {
			for _, value := range values {
				request.Header.Add(name, value)
			}
		}
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

func taskLeaseHeader(token string) http.Header {
	return http.Header{"Task-Lease-Token": []string{token}}
}

func taskEffectByOperation(t *testing.T, bundle taskWorkerHTTPBundle, operation, status string) struct {
	ID          string         `json:"id"`
	Operation   string         `json:"operation"`
	Status      string         `json:"status"`
	Payload     map[string]any `json:"payload"`
	Observation map[string]any `json:"observation"`
} {
	t.Helper()
	for _, effect := range bundle.Execution.Effects {
		if effect.Operation == operation && effect.Status == status {
			return effect
		}
	}
	t.Fatalf("Task effect operation=%s status=%s not found in %+v", operation, status, bundle.Execution.Effects)
	panic("unreachable")
}

func taskEffectByID(t *testing.T, bundle taskWorkerHTTPBundle, effectID string) struct {
	ID          string         `json:"id"`
	Operation   string         `json:"operation"`
	Status      string         `json:"status"`
	Payload     map[string]any `json:"payload"`
	Observation map[string]any `json:"observation"`
} {
	t.Helper()
	for _, effect := range bundle.Execution.Effects {
		if effect.ID == effectID {
			return effect
		}
	}
	t.Fatalf("Task effect %s not found", effectID)
	panic("unreachable")
}
