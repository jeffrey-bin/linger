package taskexecution

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type cleanupParticipantRun struct {
	ActorID           string `json:"actor_id"`
	AgentManagementID string `json:"agent_management_id"`
	AgentRunRef       string `json:"agent_run_ref"`
}

type cleanupPayload struct {
	ActorID             string           `json:"actor_id"`
	AgentManagementID   string           `json:"agent_management_id"`
	AgentRunRef         string           `json:"agent_run_ref,omitempty"`
	ExecutionContextRef json.RawMessage  `json:"execution_context_ref"`
	ReconcileSubmit     *reconcileSubmit `json:"reconcile_submit,omitempty"`
}

type reconcileSubmit struct {
	SourceEffectID  string          `json:"source_effect_id"`
	RootOperationID string          `json:"root_operation_id"`
	SubmitPayload   json.RawMessage `json:"submit_payload"`
}

type cleanupWitness struct {
	identity string
	payload  cleanupPayload
}

// EnqueueKnownParticipantRuns freezes one stable cleanup effect per persisted
// Local Run witness. A dispatching submit without a PG observation, or a
// classified pre-Run activation failure that may hide a partially accepted
// multi-recipient submit, gets one reconciliation cleanup per recipient so the
// Agent can replay the immutable Message identity, recover the original Local
// Run reference, and cancel it.
func EnqueueKnownParticipantRuns(
	ctx context.Context,
	queries *store.Queries,
	taskID string,
	tenantID string,
	generation int64,
) error {
	participants, err := queries.ListTaskExecutionParticipants(ctx, store.ListTaskExecutionParticipantsParams{
		TaskID: taskID, Generation: generation,
	})
	if err != nil {
		return err
	}
	byActor := make(map[string]store.TaskExecutionParticipant, len(participants))
	for _, participant := range participants {
		byActor[participant.ActorID] = participant
	}
	effects, err := queries.ListTaskEffects(ctx, store.ListTaskEffectsParams{
		TaskID: taskID, Generation: generation,
	})
	if err != nil {
		return err
	}
	witnesses := make(map[string]cleanupWitness)
	for _, effect := range effects {
		if effect.Operation != "submit_agent_turn" ||
			effect.Status != "dispatching" && effect.Status != "succeeded" && effect.Status != "failed" {
			continue
		}
		unwitnessedSubmit := len(effect.Observation) == 0
		if effect.Status == "failed" {
			var failure struct {
				FailureCode string `json:"failure_code"`
				Retryable   *bool  `json:"retryable"`
			}
			if json.Unmarshal(effect.Observation, &failure) != nil ||
				!strings.HasPrefix(failure.FailureCode, "CONTEXT_ACTIVATION_") ||
				failure.Retryable == nil {
				return fmt.Errorf("failed Task submit effect %s has invalid activation evidence", effect.ID)
			}
			unwitnessedSubmit = true
		}
		if unwitnessedSubmit {
			if effect.Status != "dispatching" && effect.Status != "failed" {
				return fmt.Errorf("completed Task submit effect %s has no Local Run witness", effect.ID)
			}
			var submit struct {
				RecipientActorIDs []string        `json:"recipient_actor_ids"`
				Message           json.RawMessage `json:"message"`
			}
			if err := json.Unmarshal(effect.Payload, &submit); err != nil || len(submit.RecipientActorIDs) == 0 || len(submit.Message) == 0 {
				return fmt.Errorf("decode Task submit payload %s: invalid recipient or Message", effect.ID)
			}
			seen := make(map[string]struct{}, len(submit.RecipientActorIDs))
			for _, actorID := range submit.RecipientActorIDs {
				actorID = strings.TrimSpace(actorID)
				participant, ok := byActor[actorID]
				if !ok || actorID == "" {
					return fmt.Errorf("Task submit payload %s has an unknown participant", effect.ID)
				}
				if _, duplicate := seen[actorID]; duplicate {
					return fmt.Errorf("Task submit payload %s has duplicate participants", effect.ID)
				}
				seen[actorID] = struct{}{}
				if err := validateCleanupParticipant(taskID, participant); err != nil {
					return err
				}
				identity := "submit-effect:" + effect.ID + ":actor:" + actorID
				witnesses[identity] = cleanupWitness{
					identity: identity,
					payload: cleanupPayload{
						ActorID: actorID, AgentManagementID: participant.AgentManagementID,
						ExecutionContextRef: json.RawMessage(append([]byte(nil), participant.ExecutionContextRef...)),
						ReconcileSubmit: &reconcileSubmit{
							SourceEffectID: effect.ID, RootOperationID: effect.RootOperationID,
							SubmitPayload: json.RawMessage(append([]byte(nil), effect.Payload...)),
						},
					},
				}
			}
			continue
		}
		var observation struct {
			ParticipantRuns []cleanupParticipantRun `json:"participant_runs"`
		}
		if err := json.Unmarshal(effect.Observation, &observation); err != nil {
			return fmt.Errorf("decode Task submit witness %s: %w", effect.ID, err)
		}
		for _, run := range observation.ParticipantRuns {
			run.AgentRunRef = strings.TrimSpace(run.AgentRunRef)
			participant, ok := byActor[run.ActorID]
			if !ok || participant.AgentManagementID != run.AgentManagementID || run.AgentRunRef == "" || len(run.AgentRunRef) > 500 {
				return fmt.Errorf("Task submit witness %s does not match a participant", effect.ID)
			}
			if err := validateCleanupParticipant(taskID, participant); err != nil {
				return err
			}
			payload := cleanupPayload{
				ActorID: run.ActorID, AgentManagementID: run.AgentManagementID,
				AgentRunRef:         run.AgentRunRef,
				ExecutionContextRef: json.RawMessage(append([]byte(nil), participant.ExecutionContextRef...)),
			}
			if existing, duplicate := witnesses[run.AgentRunRef]; duplicate &&
				(existing.payload.ActorID != payload.ActorID || existing.payload.AgentManagementID != payload.AgentManagementID ||
					string(existing.payload.ExecutionContextRef) != string(payload.ExecutionContextRef)) {
				return fmt.Errorf("Task Local Run witness %s has conflicting participants", run.AgentRunRef)
			}
			witnesses[run.AgentRunRef] = cleanupWitness{identity: run.AgentRunRef, payload: payload}
		}
	}
	identities := make([]string, 0, len(witnesses))
	for identity := range witnesses {
		identities = append(identities, identity)
	}
	sort.Strings(identities)
	for _, identity := range identities {
		witness := witnesses[identity]
		payload, err := json.Marshal(witness.payload)
		if err != nil {
			return err
		}
		payloadHash := sha256.Sum256(payload)
		identityHash := sha256.Sum256([]byte(taskID + "\x00" + strconv.FormatInt(generation, 10) + "\x00" + witness.identity))
		effectIdentity := hex.EncodeToString(identityHash[:16])
		rootOperationID := "task:" + taskID + ":g:" + strconv.FormatInt(generation, 10) + ":runtime-cleanup:" + effectIdentity
		written, err := queries.InsertTaskRuntimeCleanupEffect(ctx, store.InsertTaskRuntimeCleanupEffectParams{
			ID: "task_effect_cleanup_" + effectIdentity, TaskID: taskID, TenantID: tenantID,
			Generation: generation, RootOperationID: rootOperationID,
			EffectKey: rootOperationID + ":cleanup", Payload: payload, PayloadHash: payloadHash[:],
		})
		if err != nil {
			return err
		}
		if written != 1 {
			return fmt.Errorf("Task runtime cleanup effect %s conflicts with persisted evidence", effectIdentity)
		}
	}
	return nil
}

func validateCleanupParticipant(taskID string, participant store.TaskExecutionParticipant) error {
	var contextRef struct {
		Kind    string `json:"kind"`
		AgentID string `json:"agentId"`
		TaskID  string `json:"taskId"`
	}
	if json.Unmarshal(participant.ExecutionContextRef, &contextRef) != nil || contextRef.Kind != "alter_ego" ||
		contextRef.AgentID != participant.AgentManagementID || contextRef.TaskID != taskID {
		return fmt.Errorf("Task participant %s has an invalid cleanup context", participant.ActorID)
	}
	return nil
}
