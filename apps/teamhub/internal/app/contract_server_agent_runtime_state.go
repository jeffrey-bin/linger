package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

const agentRuntimeStateRequestMaxBytes = 8 << 20

func (a *App) getAgentExecutionContext(c *gin.Context) {
	params := contractParams[teamhubinternal.GetAgentExecutionContextParams](c)
	value, err := a.agentRuntimeState.GetContext(c.Request.Context(), params.ContextKey)
	if a.writeAgentRuntimeStateError(c, "get Execution Context", err) {
		return
	}
	response, err := agentExecutionContextToContract(value)
	if a.writeAgentRuntimeStateProjectionError(c, "project Execution Context", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) listAgentExecutionContexts(c *gin.Context) {
	params := contractParams[teamhubinternal.ListAgentExecutionContextsParams](c)
	agentID := ""
	if params.AgentId != nil {
		agentID = *params.AgentId
	}
	values, err := a.agentRuntimeState.ListContexts(c.Request.Context(), agentID)
	if a.writeAgentRuntimeStateError(c, "list Execution Contexts", err) {
		return
	}
	contexts, err := agentExecutionContextsToContract(values)
	if a.writeAgentRuntimeStateProjectionError(c, "project Execution Contexts", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentExecutionContextList{Contexts: contexts})
}

func (a *App) reconcileAgentExecutionContexts(c *gin.Context) {
	var request teamhubinternal.ReconcileAgentExecutionContextsRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	result, err := a.agentRuntimeState.ReconcileMetaContexts(c.Request.Context(), agentruntimestate.ReconcileMetaContextsInput{
		Limit: request.Limit, Cursor: stringValue(request.Cursor),
	})
	if a.writeAgentRuntimeStateError(c, "reconcile Execution Contexts", err) {
		return
	}
	response := teamhubinternal.ReconcileAgentExecutionContextsResult{
		ExaminedCount: result.ExaminedCount, ExistingCount: result.ExistingCount,
		CreatedCount: result.CreatedCount, CreatedContextKeys: result.CreatedContextKeys,
	}
	if result.NextCursor != "" {
		response.NextCursor = &result.NextCursor
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) ensureAgentExecutionContext(c *gin.Context) {
	var request teamhubinternal.EnsureAgentExecutionContextRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	ref, err := agentRuntimeContextRefFromContract(request.Ref)
	if err != nil {
		a.writeAgentRuntimeStateError(c, "ensure Execution Context", agentruntimestate.ErrInvalid)
		return
	}
	result, err := a.agentRuntimeState.EnsureContext(c.Request.Context(), agentruntimestate.EnsureContextInput{
		Ref:             ref,
		TargetResidency: string(request.TargetResidency),
	})
	if a.writeAgentRuntimeStateError(c, "ensure Execution Context", err) {
		return
	}
	contextValue, err := agentExecutionContextToContract(result.Context)
	if a.writeAgentRuntimeStateProjectionError(c, "project ensured Execution Context", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.EnsureAgentExecutionContextResult{Created: result.Created, Context: contextValue})
}

func (a *App) setAgentExecutionContextResidency(c *gin.Context) {
	var request teamhubinternal.SetAgentExecutionContextResidencyRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	expected, ok := a.parseAgentRuntimePositiveInt64(c, request.ExpectedRevision)
	if !ok {
		return
	}
	value, err := a.agentRuntimeState.SetContextResidency(c.Request.Context(), agentruntimestate.SetContextResidencyInput{
		ContextKey:       request.ContextKey,
		ExpectedRevision: expected,
		TargetResidency:  string(request.TargetResidency),
	})
	if a.writeAgentRuntimeStateError(c, "set Execution Context residency", err) {
		return
	}
	response, err := agentExecutionContextToContract(value)
	if a.writeAgentRuntimeStateProjectionError(c, "project Execution Context residency", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) deleteAgentExecutionContext(c *gin.Context) {
	var request teamhubinternal.DeleteAgentExecutionContextRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	expected, ok := a.parseAgentRuntimePositiveInt64(c, request.ExpectedRevision)
	if !ok {
		return
	}
	deleted, err := a.agentRuntimeState.DeleteContext(c.Request.Context(), agentruntimestate.DeleteContextInput{
		ContextKey: request.ContextKey, ExpectedRevision: expected,
	})
	if a.writeAgentRuntimeStateError(c, "delete Execution Context", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeDeletedResult{Deleted: deleted})
}

func acceptedContextStateToContract(state *agentruntimestate.ContextState) *teamhubinternal.AgentRuntimeAcceptedContextState {
	if state == nil {
		return nil
	}
	return &teamhubinternal.AgentRuntimeAcceptedContextState{
		StateRevision: strconv.FormatInt(state.StateRevision, 10), NextInputSequence: strconv.FormatInt(state.NextInputSequence, 10),
		TargetResidency: teamhubinternal.AgentRuntimeAcceptedContextStateTargetResidency(state.TargetResidency),
	}
}

func (a *App) acceptAgentRuntimeTrustedNotification(c *gin.Context) {
	var request teamhubinternal.AcceptAgentTrustedNotificationRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	input, err := agentRuntimeInputFromContract(request.Input)
	if err != nil {
		a.writeAgentRuntimeStateError(c, "accept trusted Runtime notification", agentruntimestate.ErrInvalid)
		return
	}
	result, err := a.agentRuntimeState.AcceptTrustedNotification(c.Request.Context(), agentruntimestate.AcceptTrustedNotificationInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch,
		ExecutionRunRef: request.ExecutionRunRef, Input: input,
	})
	if a.writeAgentRuntimeStateError(c, "accept trusted Runtime notification", err) {
		return
	}
	response := teamhubinternal.AcceptAgentTrustedNotificationResult{
		Status: teamhubinternal.AcceptAgentTrustedNotificationResultStatus(result.Status),
	}
	if result.SteerGroupID != "" {
		response.SteerGroupId = &result.SteerGroupID
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) submitAgentRuntimeTrustedTurn(c *gin.Context) {
	var request teamhubinternal.SubmitAgentTrustedTurnRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	inputs, err := agentRuntimeInputsFromContract(request.Inputs)
	if err != nil {
		a.writeAgentRuntimeStateError(c, "submit trusted Runtime turn", agentruntimestate.ErrInvalid)
		return
	}
	result, err := a.agentRuntimeState.SubmitTrustedTurn(c.Request.Context(), agentruntimestate.SubmitTrustedTurnInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, Inputs: inputs,
	})
	if a.writeAgentRuntimeStateError(c, "submit trusted Runtime turn", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.SubmitAgentTrustedTurnResult{RunId: result.RunID, Created: &result.Created, Context: acceptedContextStateToContract(result.Context)})
}

func (a *App) getAgentLocalRun(c *gin.Context) {
	params := contractParams[teamhubinternal.GetAgentLocalRunParams](c)
	value, err := a.agentRuntimeState.GetLocalRun(c.Request.Context(), params.ContextKey, params.LocalRunId)
	if a.writeAgentRuntimeStateError(c, "get Local Run", err) {
		return
	}
	response, err := agentLocalRunToContract(value)
	if a.writeAgentRuntimeStateProjectionError(c, "project Local Run", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) claimAgentLocalRun(c *gin.Context) {
	var request teamhubinternal.ClaimAgentLocalRunRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	result, err := a.agentRuntimeState.ClaimLocalRun(c.Request.Context(), agentruntimestate.ClaimLocalRunInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, ClaimID: request.ClaimId,
	})
	if a.writeAgentRuntimeStateError(c, "claim Local Run", err) {
		return
	}
	response := teamhubinternal.ClaimAgentLocalRunResult{Claimed: result.Run != nil}
	if result.Run != nil {
		inputs, err := storedAgentRuntimeInputsToContract(result.Run.Inputs)
		if a.writeAgentRuntimeStateProjectionError(c, "project claimed Local Run", err) {
			return
		}
		response.Run = &teamhubinternal.ClaimedAgentLocalRun{
			RunId: result.Run.RunID, AttemptCount: result.Run.AttemptCount, Inputs: inputs,
			CancellationRequested: &result.Run.CancellationRequested,
			ContinuesContext:      result.Run.ContinuesContext,
		}
		if update := result.Run.ProfileUpdate; update != nil {
			response.Run.ProfileUpdate = &teamhubinternal.AgentProfileUpdate{
				ConfigurationRevision: update.ConfigurationRevision, Name: update.Name, Instructions: update.Instructions,
			}
		}
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) requeueAgentLocalRun(c *gin.Context) {
	var request teamhubinternal.RequeueAgentLocalRunRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	err := a.agentRuntimeState.RequeueLocalRun(c.Request.Context(), agentruntimestate.RequeueLocalRunInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, RunID: request.RunId,
	})
	if a.writeAgentRuntimeStateError(c, "requeue Local Run", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeSuccessResult{Success: true})
}

func (a *App) finishAgentLocalRun(c *gin.Context) {
	var request teamhubinternal.FinishAgentLocalRunRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	terminal, err := json.Marshal(request.Terminal)
	if err != nil {
		a.writeAgentRuntimeStateError(c, "finish Local Run", agentruntimestate.ErrInvalid)
		return
	}
	var checkpoint *agentruntimestate.RuntimeSessionCheckpoint
	if request.Session != nil {
		value, ok := a.agentRuntimeSessionCheckpointFromContract(c, *request.Session)
		if !ok {
			return
		}
		checkpoint = &value
	}
	result, err := a.agentRuntimeState.FinishLocalRun(c.Request.Context(), agentruntimestate.FinishLocalRunInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, RunID: request.RunId,
		Terminal: terminal, Session: checkpoint,
	})
	if a.writeAgentRuntimeStateError(c, "finish Local Run", err) {
		return
	}
	run, err := agentLocalRunToContract(result.Run)
	if a.writeAgentRuntimeStateProjectionError(c, "project finished Local Run", err) {
		return
	}
	response := teamhubinternal.FinishAgentLocalRunResult{Run: run}
	if result.Session != nil {
		session, err := agentRuntimeSessionToContract(*result.Session)
		if a.writeAgentRuntimeStateProjectionError(c, "project RuntimeSession", err) {
			return
		}
		response.Session = &session
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) cancelAgentLocalRun(c *gin.Context) {
	var request teamhubinternal.CancelAgentLocalRunRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	result, err := a.agentRuntimeState.CancelLocalRun(c.Request.Context(), agentruntimestate.CancelLocalRunInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, RunID: request.RunId,
	})
	if a.writeAgentRuntimeStateError(c, "cancel Local Run", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.CancelAgentLocalRunResult{Status: teamhubinternal.CancelAgentLocalRunResultStatus(result.Status)})
}

func (a *App) enqueueAgentRuntimeSteer(c *gin.Context) {
	var request teamhubinternal.EnqueueAgentSteerRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	result, err := a.agentRuntimeState.EnqueueSteer(c.Request.Context(), agentruntimestate.EnqueueSteerInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, GroupID: request.GroupId,
	})
	if a.writeAgentRuntimeStateError(c, "enqueue Runtime steer", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.EnqueueAgentSteerResult{RunId: result.RunID})
}

func (a *App) assignAgentRuntimeSteerRun(c *gin.Context) {
	var request teamhubinternal.AssignAgentSteerRunRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	err := a.agentRuntimeState.AssignSteerRun(c.Request.Context(), agentruntimestate.AssignSteerRunInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, GroupID: request.GroupId, RunID: request.RunId,
	})
	if a.writeAgentRuntimeStateError(c, "assign Runtime steer", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeSuccessResult{Success: true})
}

func (a *App) completeAgentRuntimeSteer(c *gin.Context) {
	var request teamhubinternal.CompleteAgentSteerRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	err := a.agentRuntimeState.CompleteSteer(c.Request.Context(), agentruntimestate.CompleteSteerInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch,
		GroupID: request.GroupId, RunID: request.RunId, Outcome: string(request.Outcome),
	})
	if a.writeAgentRuntimeStateError(c, "complete Runtime steer", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeSuccessResult{Success: true})
}

func (a *App) getAgentRuntimeSession(c *gin.Context) {
	params := contractParams[teamhubinternal.GetAgentRuntimeSessionParams](c)
	value, err := a.agentRuntimeState.GetRuntimeSession(c.Request.Context(), params.ContextKey)
	if a.writeAgentRuntimeStateError(c, "get RuntimeSession", err) {
		return
	}
	response := teamhubinternal.GetAgentRuntimeSessionResult{Available: value != nil}
	if value != nil {
		session, err := agentRuntimeSessionToContract(*value)
		if a.writeAgentRuntimeStateProjectionError(c, "project RuntimeSession", err) {
			return
		}
		response.Session = &session
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) checkpointAgentRuntimeSession(c *gin.Context) {
	var request teamhubinternal.CheckpointAgentRuntimeSessionRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	checkpoint, ok := a.agentRuntimeSessionCheckpointFromContract(c, request.Checkpoint)
	if !ok {
		return
	}
	result, err := a.agentRuntimeState.CheckpointRuntimeSession(c.Request.Context(), agentruntimestate.CheckpointSessionInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, Checkpoint: checkpoint,
	})
	if a.writeAgentRuntimeStateError(c, "checkpoint RuntimeSession", err) {
		return
	}
	response, err := agentRuntimeSessionToContract(result)
	if a.writeAgentRuntimeStateProjectionError(c, "project checkpointed RuntimeSession", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) clearAgentRuntimeSession(c *gin.Context) {
	var request teamhubinternal.ClearAgentRuntimeSessionRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	configurationRevision, ok := a.parseAgentRuntimePositiveInt64(c, request.ConfigurationRevision)
	if !ok {
		return
	}
	var expectedCurrentRevision *int64
	if request.ExpectedCurrentConfigurationRevision != nil {
		value, ok := a.parseAgentRuntimePositiveInt64(c, *request.ExpectedCurrentConfigurationRevision)
		if !ok {
			return
		}
		expectedCurrentRevision = &value
	}
	result, err := a.agentRuntimeState.ClearRuntimeSession(c.Request.Context(), agentruntimestate.ClearRuntimeSessionInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch,
		ConfigurationRevision: configurationRevision, ExpectedCurrentConfigurationRevision: expectedCurrentRevision,
	})
	if a.writeAgentRuntimeStateError(c, "clear RuntimeSession", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.ClearAgentRuntimeSessionResult{Cleared: result.Cleared})
}

func (a *App) getAgentRuntimeWorkState(c *gin.Context) {
	params := contractParams[teamhubinternal.GetAgentRuntimeWorkStateParams](c)
	pending, err := a.agentRuntimeState.ContextHasPendingWork(c.Request.Context(), params.ContextKey)
	if a.writeAgentRuntimeStateError(c, "get Runtime pending work", err) {
		return
	}
	queued, err := a.agentRuntimeState.ContextHasQueuedRuns(c.Request.Context(), params.ContextKey)
	if a.writeAgentRuntimeStateError(c, "get Runtime queued Runs", err) {
		return
	}
	steers, err := a.agentRuntimeState.ListMessageSteers(c.Request.Context(), params.ContextKey)
	if a.writeAgentRuntimeStateError(c, "list Runtime Message steers", err) {
		return
	}
	messageSteers, err := storedAgentRuntimeInputsToContract(steers)
	if a.writeAgentRuntimeStateProjectionError(c, "project Runtime Message steers", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeWorkState{
		HasPendingWork: pending, HasQueuedRuns: queued, MessageSteers: &messageSteers,
	})
}

// listAgentRuntimeWaitingContexts serves the Agent Service's fallback scan.
func (a *App) listAgentRuntimeWaitingContexts(c *gin.Context) {
	keys, err := a.agentRuntimeState.ListWaitingContexts(c.Request.Context())
	if a.writeAgentRuntimeStateError(c, "list Runtime waiting Contexts", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeWaitingContexts{ContextKeys: keys})
}

func (a *App) openAgentRuntimeStatus(c *gin.Context) {
	var request teamhubinternal.OpenAgentRuntimeStatusRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	result, err := a.agentRuntimeState.OpenRuntimeStatus(c.Request.Context(), agentruntimestate.OpenStatusInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch,
		LocalRunID: request.LocalRunId, InitialSourceIDs: request.InitialSourceIds,
	})
	if a.writeAgentRuntimeStateError(c, "open Runtime status", err) {
		return
	}
	response := teamhubinternal.OpenAgentRuntimeStatusResult{Opened: result.Opened}
	if result.RoomID != "" {
		response.RoomId = &result.RoomID
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) offerAgentRuntimePresentationEvents(c *gin.Context) {
	var request teamhubinternal.OfferAgentRuntimePresentationEventsRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	events := make([]agentruntimestate.OfferedPresentationEvent, 0, len(request.Events))
	for _, item := range request.Events {
		event, err := json.Marshal(item.Event)
		if err != nil {
			a.writeAgentRuntimeStateError(c, "encode Runtime presentation event", agentruntimestate.ErrInvalid)
			return
		}
		events = append(events, agentruntimestate.OfferedPresentationEvent{CommandID: item.CommandId, Event: event})
	}
	result, err := a.agentRuntimeState.OfferRuntimePresentationEvents(c.Request.Context(), agentruntimestate.OfferPresentationEventsInput{
		LocalRunID: request.LocalRunId, Events: events,
	})
	if a.writeAgentRuntimeStateError(c, "offer Runtime presentation events", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.OfferAgentRuntimePresentationEventsResult{
		Accepted: result.Accepted, EventOrdinal: strconv.FormatInt(result.EventOrdinal, 10),
	})
}

func (a *App) decodeAgentRuntimeStateBody(c *gin.Context, target any) bool {
	if a.agentRuntimeState == nil {
		a.writeAgentRuntimeStateInternalError(c, "Agent Runtime State service is unavailable")
		return false
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, agentRuntimeStateRequestMaxBytes)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		a.writeAgentRuntimeStateError(c, "decode Agent Runtime State request", agentruntimestate.ErrInvalid)
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		a.writeAgentRuntimeStateError(c, "decode Agent Runtime State request", agentruntimestate.ErrInvalid)
		return false
	}
	return true
}

func (a *App) parseAgentRuntimePositiveInt64(c *gin.Context, raw string) (int64, bool) {
	return a.parseAgentRuntimeInt64(c, raw, true)
}

func (a *App) parseAgentRuntimeInt64(c *gin.Context, raw string, positive bool) (int64, bool) {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 || (positive && value == 0) || strconv.FormatInt(value, 10) != raw {
		a.writeAgentRuntimeStateError(c, "parse Agent Runtime State integer", agentruntimestate.ErrInvalid)
		return 0, false
	}
	return value, true
}

func (a *App) agentRuntimeSessionCheckpointFromContract(
	c *gin.Context,
	value teamhubinternal.AgentRuntimeSessionCheckpoint,
) (agentruntimestate.RuntimeSessionCheckpoint, bool) {
	expected, ok := a.parseAgentRuntimeInt64(c, value.ExpectedRevision, false)
	if !ok {
		return agentruntimestate.RuntimeSessionCheckpoint{}, false
	}
	schemaVersion, ok := a.parseAgentRuntimePositiveInt64(c, value.SchemaVersion)
	if !ok {
		return agentruntimestate.RuntimeSessionCheckpoint{}, false
	}
	configurationRevision, ok := a.parseAgentRuntimePositiveInt64(c, value.ConfigurationRevision)
	if !ok {
		return agentruntimestate.RuntimeSessionCheckpoint{}, false
	}
	session, err := json.Marshal(value.Session)
	if err != nil {
		a.writeAgentRuntimeStateError(c, "decode RuntimeSession", agentruntimestate.ErrInvalid)
		return agentruntimestate.RuntimeSessionCheckpoint{}, false
	}
	return agentruntimestate.RuntimeSessionCheckpoint{
		ExpectedRevision: expected, ProviderKind: value.ProviderKind, SchemaVersion: schemaVersion,
		Session: session, ThreadID: stringValue(value.ThreadId), ConfigurationRevision: configurationRevision,
	}, true
}

func (a *App) writeAgentRuntimeStateError(c *gin.Context, operation string, err error) bool {
	if err == nil {
		return false
	}
	// A canceled dependency on a live request (or a joined real failure) is
	// still a fault. Only a request cancellation with no other cause is expected.
	if c.Request.Context().Err() == context.Canceled && onlyRuntimeCancellation(err) {
		if a.logger != nil {
			a.logger.Info(operation, "request_id", c.GetString("request_id"),
				"outcome", "request_canceled", "request_context", "canceled")
		}
		c.Set("request_canceled", true)
		c.Abort()
		return true
	}
	status := http.StatusInternalServerError
	code := "INTERNAL_ERROR"
	message := "Agent Runtime State request could not be completed"
	switch {
	case errors.Is(err, agentruntimestate.ErrInvalid):
		status, code, message = http.StatusBadRequest, "INVALID_REQUEST", "Agent Runtime State request is invalid"
	case errors.Is(err, agentruntimestate.ErrNotFound):
		status, code, message = http.StatusNotFound, "NOT_FOUND", "Agent Runtime State was not found"
	case errors.Is(err, agentruntimestate.ErrIdempotencyConflict):
		status, code, message = http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "Agent Runtime command ID was reused with different input"
	case errors.Is(err, agentruntimestate.ErrRunnerReceiptRunSettled):
		status, code, message = http.StatusConflict, "RUNNER_RECEIPT_RUN_SETTLED", "Runner receipt targets an already settled Local Run"
	case errors.Is(err, agentruntimestate.ErrFenced):
		status, code, message = http.StatusConflict, "CONTEXT_FENCED", "Agent Runtime Context identity or Agent Service epoch is no longer authoritative"
	case errors.Is(err, agentruntimestate.ErrInboxNotAuthorized):
		status, code, message = http.StatusForbidden, "INBOX_NOT_AUTHORIZED", "Agent Runtime Context cannot receive this Inbox"
	case errors.Is(err, agentruntimestate.ErrConflict):
		status, code, message = http.StatusConflict, "AGENT_RUNTIME_CONFLICT", "Agent Runtime State conflicts with the request"
	case errors.Is(err, agentruntimestate.ErrDependency):
		status, code, message = http.StatusServiceUnavailable, "AGENT_RUNTIME_DEPENDENCY_FAILED", "Agent Runtime State dependency is unavailable"
	default:
		if a.logger != nil {
			a.logger.Error(operation, "request_id", c.GetString("request_id"), "error", err)
		}
	}
	a.writeError(c, status, code, message)
	return true
}

// Walk joined errors as well as wrappers so cancellation cannot hide a fault.
func onlyRuntimeCancellation(err error) bool {
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		if len(children) == 0 {
			return false
		}
		for _, child := range children {
			if !onlyRuntimeCancellation(child) {
				return false
			}
		}
		return true
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return onlyRuntimeCancellation(wrapped.Unwrap())
	}
	return errors.Is(err, context.Canceled)
}

func (a *App) writeAgentRuntimeStateProjectionError(c *gin.Context, operation string, err error) bool {
	if err == nil {
		return false
	}
	if a.logger != nil {
		a.logger.Error(operation, "request_id", c.GetString("request_id"), "error", err)
	}
	a.writeAgentRuntimeStateInternalError(c, "Agent Runtime State response could not be projected")
	return true
}

func (a *App) writeAgentRuntimeStateInternalError(c *gin.Context, message string) {
	a.writeError(c, http.StatusInternalServerError, "INTERNAL_ERROR", message)
}

func agentRuntimeContextRefFromContract(value teamhubinternal.AgentRuntimeContextRef) (agentruntimestate.ContextRef, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return agentruntimestate.ContextRef{}, err
	}
	var fields map[string]json.RawMessage
	var discriminator struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(raw, &discriminator) != nil {
		return agentruntimestate.ContextRef{}, agentruntimestate.ErrInvalid
	}
	switch discriminator.Kind {
	case "meta":
		if len(fields) != 3 {
			return agentruntimestate.ContextRef{}, agentruntimestate.ErrInvalid
		}
		variant, err := value.AsAgentRuntimeContextRef0()
		if err != nil || variant.Kind != "meta" || variant.RoomId == "" {
			return agentruntimestate.ContextRef{}, agentruntimestate.ErrInvalid
		}
		return agentruntimestate.ContextRef{Kind: variant.Kind, AgentID: variant.AgentId, RoomID: variant.RoomId}, nil
	case "alter_ego":
		if len(fields) != 3 {
			return agentruntimestate.ContextRef{}, agentruntimestate.ErrInvalid
		}
		variant, err := value.AsAgentRuntimeContextRef1()
		if err != nil || variant.Kind != "alter_ego" {
			return agentruntimestate.ContextRef{}, agentruntimestate.ErrInvalid
		}
		return agentruntimestate.ContextRef{Kind: variant.Kind, AgentID: variant.AgentId, TaskID: variant.TaskId}, nil
	case "document":
		if len(fields) != 3 {
			return agentruntimestate.ContextRef{}, agentruntimestate.ErrInvalid
		}
		variant, err := value.AsAgentRuntimeContextRef2()
		if err != nil || variant.Kind != "document" {
			return agentruntimestate.ContextRef{}, agentruntimestate.ErrInvalid
		}
		return agentruntimestate.ContextRef{Kind: variant.Kind, AgentID: variant.AgentId, DocumentID: variant.DocumentId}, nil
	default:
		return agentruntimestate.ContextRef{}, agentruntimestate.ErrInvalid
	}
}

func agentRuntimeContextRefToContract(value agentruntimestate.ContextRef) (teamhubinternal.AgentRuntimeContextRef, error) {
	var result teamhubinternal.AgentRuntimeContextRef
	var err error
	switch value.Kind {
	case "meta":
		if value.RoomID == "" {
			err = agentruntimestate.ErrInvalid
		} else {
			err = result.FromAgentRuntimeContextRef0(teamhubinternal.AgentRuntimeContextRef0{Kind: "meta", AgentId: value.AgentID, RoomId: value.RoomID})
		}
	case "alter_ego":
		err = result.FromAgentRuntimeContextRef1(teamhubinternal.AgentRuntimeContextRef1{Kind: "alter_ego", AgentId: value.AgentID, TaskId: value.TaskID})
	case "document":
		if value.DocumentID == "" || value.RoomID != "" || value.TaskID != "" {
			err = agentruntimestate.ErrInvalid
		} else {
			err = result.FromAgentRuntimeContextRef2(teamhubinternal.AgentRuntimeContextRef2{Kind: "document", AgentId: value.AgentID, DocumentId: value.DocumentID})
		}
	default:
		err = agentruntimestate.ErrInvalid
	}
	return result, err
}

func agentExecutionContextToContract(value agentruntimestate.Context) (teamhubinternal.AgentExecutionContext, error) {
	ref, err := agentRuntimeContextRefToContract(value.Ref)
	if err != nil {
		return teamhubinternal.AgentExecutionContext{}, err
	}
	result := teamhubinternal.AgentExecutionContext{
		Ref: ref, ContextKey: value.ContextKey, TenantId: value.TenantID, AgentActorId: value.AgentActorID,
		TargetResidency: teamhubinternal.AgentExecutionContextTargetResidency(value.TargetResidency),
		StateRevision:   strconv.FormatInt(value.StateRevision, 10), NextInputSequence: strconv.FormatInt(value.NextInputSequence, 10),
	}
	if value.RoomKind != "" {
		roomKind := teamhubinternal.AgentExecutionContextRoomKind(value.RoomKind)
		result.RoomKind = &roomKind
	}
	if scope := value.SharedTaskScope; scope != nil {
		result.SharedTaskScope = &teamhubinternal.AgentRuntimeSharedTaskScope{
			Version: teamhubinternal.AgentRuntimeSharedTaskScopeVersion(scope.Version), TenantId: scope.TenantID,
			AgentId: scope.AgentID, OriginRoomId: scope.OriginRoomID, Role: teamhubinternal.AgentRuntimeSharedTaskScopeRole(scope.Role),
		}
		if scope.TaskID != "" {
			result.SharedTaskScope.TaskId = &scope.TaskID
		}
	}
	if value.MembershipEpochID != "" {
		result.MembershipEpochId = &value.MembershipEpochID
	}
	if value.TerminalReason != "" {
		reason := teamhubinternal.AgentExecutionContextTerminalReason(value.TerminalReason)
		result.TerminalReason = &reason
		result.TerminatedAt = value.TerminatedAt
	}
	return result, nil
}

func agentExecutionContextsToContract(values []agentruntimestate.Context) ([]teamhubinternal.AgentExecutionContext, error) {
	result := make([]teamhubinternal.AgentExecutionContext, len(values))
	for index, value := range values {
		converted, err := agentExecutionContextToContract(value)
		if err != nil {
			return nil, err
		}
		result[index] = converted
	}
	return result, nil
}

func agentRuntimeInputFromContract(value teamhubinternal.AgentRuntimeInput) (agentruntimestate.RuntimeInput, error) {
	payload, err := json.Marshal(value.Payload)
	if err != nil {
		return agentruntimestate.RuntimeInput{}, err
	}
	return agentruntimestate.RuntimeInput{
		InputID: value.InputId, Payload: payload, SourceKind: string(value.SourceKind),
		SourceMessageID: stringValue(value.SourceMessageId), SourceInboxID: stringValue(value.SourceInboxId),
	}, nil
}

func agentRuntimeInputsFromContract(values []teamhubinternal.AgentRuntimeInput) ([]agentruntimestate.RuntimeInput, error) {
	result := make([]agentruntimestate.RuntimeInput, len(values))
	for index, value := range values {
		converted, err := agentRuntimeInputFromContract(value)
		if err != nil {
			return nil, err
		}
		result[index] = converted
	}
	return result, nil
}

func storedAgentRuntimeInputToContract(value agentruntimestate.StoredRuntimeInput) (teamhubinternal.StoredAgentRuntimeInput, error) {
	payload, err := decodeAgentRuntimeJSONObject(value.Payload)
	if err != nil {
		return teamhubinternal.StoredAgentRuntimeInput{}, err
	}
	result := teamhubinternal.StoredAgentRuntimeInput{
		InputId: value.InputID, Payload: payload, SourceKind: teamhubinternal.StoredAgentRuntimeInputSourceKind(value.SourceKind),
		SourceMessageId: runtimeStringPointer(value.SourceMessageID), SourceInboxId: runtimeStringPointer(value.SourceInboxID),
		Sequence: strconv.FormatInt(value.Sequence, 10), Status: teamhubinternal.StoredAgentRuntimeInputStatus(value.Status),
		SteerGroupId: runtimeStringPointer(value.SteerGroupID), LocalRunId: runtimeStringPointer(value.LocalRunID),
	}
	if !value.CreatedAt.IsZero() {
		createdAt := value.CreatedAt
		result.CreatedAt = &createdAt
	}
	if len(value.SelectionResult) > 0 {
		selection, err := decodeAgentRuntimeJSONObject(value.SelectionResult)
		if err != nil {
			return teamhubinternal.StoredAgentRuntimeInput{}, err
		}
		result.SelectionResult = &selection
	}
	if value.SteerOutcome != "" {
		outcome := teamhubinternal.StoredAgentRuntimeInputSteerOutcome(value.SteerOutcome)
		result.SteerOutcome = &outcome
	}
	return result, nil
}

func storedAgentRuntimeInputsToContract(values []agentruntimestate.StoredRuntimeInput) ([]teamhubinternal.StoredAgentRuntimeInput, error) {
	result := make([]teamhubinternal.StoredAgentRuntimeInput, len(values))
	for index, value := range values {
		converted, err := storedAgentRuntimeInputToContract(value)
		if err != nil {
			return nil, err
		}
		result[index] = converted
	}
	return result, nil
}

func agentLocalRunToContract(value agentruntimestate.LocalRun) (teamhubinternal.AgentLocalRun, error) {
	result := teamhubinternal.AgentLocalRun{
		CancellationRequested: &value.CancellationRequested,
		RunId:                 value.RunID, ContextKey: value.ContextKey, Status: teamhubinternal.AgentLocalRunStatus(value.Status),
		AttemptCount:    value.AttemptCount,
		InitialInputIds: nonNilStrings(value.InitialInputIDs), SteerInputIds: nonNilStrings(value.SteerInputIDs),
	}
	if len(value.Terminal) > 0 {
		terminal, err := decodeAgentRuntimeJSONObject(value.Terminal)
		if err != nil {
			return teamhubinternal.AgentLocalRun{}, err
		}
		result.Terminal = &terminal
	}
	return result, nil
}

func agentRuntimeSessionToContract(value agentruntimestate.RuntimeSession) (teamhubinternal.AgentRuntimeSession, error) {
	session, err := decodeAgentRuntimeJSONObject(value.Session)
	if err != nil {
		return teamhubinternal.AgentRuntimeSession{}, err
	}
	result := teamhubinternal.AgentRuntimeSession{
		ExpectedRevision: strconv.FormatInt(value.ExpectedRevision, 10), ProviderKind: value.ProviderKind,
		SchemaVersion: strconv.FormatInt(value.SchemaVersion, 10), Session: session,
		ThreadId: runtimeStringPointer(value.ThreadID), ConfigurationRevision: strconv.FormatInt(value.ConfigurationRevision, 10),
		Revision: strconv.FormatInt(value.Revision, 10), UpdatedAt: value.UpdatedAt,
	}
	if value.CompatibleConfigurationRevision > 0 {
		result.CompatibleConfigurationRevision = runtimeStringPointer(strconv.FormatInt(value.CompatibleConfigurationRevision, 10))
	}
	return result, nil
}

func decodeAgentRuntimeJSONObject(raw json.RawMessage) (map[string]interface{}, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value map[string]interface{}
	if err := decoder.Decode(&value); err != nil || value == nil {
		if err == nil {
			err = errors.New("Agent Runtime JSON object is null")
		}
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("Agent Runtime JSON object has trailing content")
	}
	return value, nil
}

func runtimeStringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func (a *App) startAgentServiceEpoch(c *gin.Context) {
	var request teamhubinternal.StartAgentServiceEpochRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	result, err := a.agentRuntimeState.StartEpoch(c.Request.Context(), request.Epoch)
	if a.writeAgentRuntimeStateError(c, "start Agent Service epoch", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentServiceEpochStart{
		InterruptedRunIds: result.InterruptedRunIDs, WaitingContextKeys: result.WaitingContextKeys,
	})
}
func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
