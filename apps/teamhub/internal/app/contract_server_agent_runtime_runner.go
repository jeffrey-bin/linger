package app

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) getAgentRuntimeLocalComputer(c *gin.Context) {
	params := contractParams[teamhubinternal.GetAgentRuntimeLocalComputerParams](c)
	value, err := a.agentRuntimeState.GetLocalComputer(c.Request.Context(), params.ComputerId)
	if a.writeAgentRuntimeStateError(c, "read Local Computer", err) {
		return
	}
	response, err := agentRuntimeLocalComputerToContract(value)
	if a.writeAgentRuntimeStateProjectionError(c, "project Local Computer", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) connectAgentRuntimeLocalComputer(c *gin.Context) {
	var request teamhubinternal.ConnectAgentRuntimeLocalComputerRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	generation, ok := a.parseAgentRuntimeInt64(c, request.CredentialGeneration, false)
	if !ok {
		return
	}
	identityVersion, ok := a.parseAgentRuntimeInt64(c, request.IdentityVersion, true)
	if !ok {
		return
	}
	runtimes, diagnostics, grants, err := marshalRunnerProjectionArrays(request.Runtimes, request.RuntimeDiagnostics, request.WorkspaceGrants)
	if err != nil || (request.Platform != nil && !request.Platform.Valid()) {
		a.writeAgentRuntimeStateError(c, "decode Local Computer connection", agentruntimestate.ErrInvalid)
		return
	}
	platform := ""
	if request.Platform != nil {
		platform = string(*request.Platform)
	}
	value, err := a.agentRuntimeState.ConnectLocalComputer(c.Request.Context(), agentruntimestate.ConnectLocalComputerInput{
		ComputerID: request.ComputerId, Owner: localComputerOwnerFromContract(request.Owner),
		CredentialGeneration: generation, DaemonID: request.DaemonId, DaemonPublicKey: request.DaemonPublicKey,
		IdentityVersion: identityVersion, Status: string(request.Status), SeenAt: request.SeenAt,
		DisplayName: request.DisplayName, Platform: platform, Capacity: optionalInt32(request.Capacity),
		Runtimes: runtimes, RuntimeDiagnostics: diagnostics, WorkspaceGrants: grants,
		DaemonVersion: request.DaemonVersion, RecommendedVersion: optionalStringValue(request.RecommendedVersion),
	})
	if a.writeAgentRuntimeStateError(c, "connect Local Computer", err) {
		return
	}
	computer, err := agentRuntimeLocalComputerToContract(value.Computer)
	if a.writeAgentRuntimeStateProjectionError(c, "project connected Local Computer", err) {
		return
	}
	placements := make([]teamhubinternal.AgentRuntimeRunnerPlacement, len(value.Placements))
	for index, placement := range value.Placements {
		placements[index] = teamhubinternal.AgentRuntimeRunnerPlacement{
			AgentId: placement.AgentID, ActorId: placement.ActorID, TenantId: placement.TenantID,
			OwnerActorId: placement.OwnerActorID, RuntimeType: teamhubinternal.LocalRuntimeType(placement.RuntimeType),
			Model: placement.Model, WorkspaceGrantId: placement.WorkspaceGrantID,
			AssignmentRevision: strconv.FormatInt(placement.AssignmentRevision, 10),
		}
		if placement.ReasoningEffort != "" {
			effort := teamhubinternal.AgentReasoningEffort(placement.ReasoningEffort)
			placements[index].ReasoningEffort = &effort
		}
	}
	c.JSON(http.StatusOK, teamhubinternal.ConnectAgentRuntimeLocalComputerResult{Computer: computer, Placements: placements})
}

func (a *App) touchAgentRuntimeLocalComputer(c *gin.Context) {
	var request teamhubinternal.TouchAgentRuntimeLocalComputerRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	var runtimes, diagnostics json.RawMessage
	var err error
	if request.Runtimes != nil {
		runtimes, err = json.Marshal(*request.Runtimes)
	}
	if err == nil && request.RuntimeDiagnostics != nil {
		diagnostics, err = json.Marshal(*request.RuntimeDiagnostics)
	}
	if err != nil {
		a.writeAgentRuntimeStateError(c, "decode Local Computer heartbeat", agentruntimestate.ErrInvalid)
		return
	}
	var activeOperations *int32
	if request.ActiveOperations != nil {
		value := int32(min(*request.ActiveOperations, math.MaxInt32))
		activeOperations = &value
	}
	value, err := a.agentRuntimeState.TouchLocalComputer(c.Request.Context(), agentruntimestate.TouchLocalComputerInput{
		ComputerID: request.ComputerId, Status: string(request.Status), SeenAt: request.SeenAt,
		Runtimes: runtimes, RuntimeDiagnostics: diagnostics, ActiveOperations: activeOperations,
		DaemonVersion: optionalStringValue(request.DaemonVersion), RecommendedVersion: optionalStringValue(request.RecommendedVersion),
	})
	if a.writeAgentRuntimeStateError(c, "touch Local Computer", err) {
		return
	}
	response, err := agentRuntimeLocalComputerToContract(value)
	if a.writeAgentRuntimeStateProjectionError(c, "project touched Local Computer", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) removeAgentRuntimeLocalComputer(c *gin.Context) {
	var request teamhubinternal.AgentRuntimeLocalComputerCredentialRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	status, err := a.agentRuntimeState.RemoveLocalComputer(c.Request.Context(), agentruntimestate.LocalComputerCredentialInput{
		ComputerID: request.ComputerId, Owner: localComputerOwnerFromContract(request.Owner),
	})
	if a.writeAgentRuntimeStateError(c, "remove Local Computer", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeLocalComputerRemovalResult{
		Status: teamhubinternal.AgentRuntimeLocalComputerRemovalResultStatus(status),
	})
}

func (a *App) recordAgentLocalRunOperation(c *gin.Context) {
	var request teamhubinternal.RecordAgentLocalRunOperationRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	var usage json.RawMessage
	if request.Usage != nil {
		encoded, err := json.Marshal(*request.Usage)
		if err != nil {
			a.writeAgentRuntimeStateError(c, "decode Runner Operation usage", agentruntimestate.ErrInvalid)
			return
		}
		usage = encoded
	}
	err := a.agentRuntimeState.RecordRunOperation(c.Request.Context(), agentruntimestate.RecordRunOperationInput{
		ContextKey: request.ContextKey, Epoch: request.Epoch, RunID: request.RunId,
		OperationID: request.OperationId, RuntimeType: string(request.RuntimeType), Usage: usage,
	})
	if a.writeAgentRuntimeStateError(c, "record Runner Operation", err) {
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.AgentRuntimeSuccessResult{Success: true})
}

func localComputerOwnerFromContract(value teamhubinternal.AgentRuntimeLocalComputerOwner) agentruntimestate.LocalComputerOwner {
	return agentruntimestate.LocalComputerOwner{TenantID: value.TenantId, OwnerActorID: value.OwnerActorId}
}

func agentRuntimeLocalComputerToContract(value agentruntimestate.LocalComputer) (teamhubinternal.AgentRuntimeLocalComputer, error) {
	var runtimes []teamhubinternal.AgentRuntimeLocalComputerRuntimes
	var diagnostics, grants []map[string]interface{}
	if err := json.Unmarshal(value.Runtimes, &runtimes); err != nil {
		return teamhubinternal.AgentRuntimeLocalComputer{}, err
	}
	if err := json.Unmarshal(value.RuntimeDiagnostics, &diagnostics); err != nil {
		return teamhubinternal.AgentRuntimeLocalComputer{}, err
	}
	if err := json.Unmarshal(value.WorkspaceGrants, &grants); err != nil {
		return teamhubinternal.AgentRuntimeLocalComputer{}, err
	}
	result := teamhubinternal.AgentRuntimeLocalComputer{
		ComputerId: value.ComputerID, DisplayName: value.DisplayName,
		Owner: teamhubinternal.AgentRuntimeLocalComputerOwner{
			TenantId: value.Owner.TenantID, OwnerActorId: value.Owner.OwnerActorID,
		},
		Status:               teamhubinternal.AgentRuntimeLocalComputerStatus(value.Status),
		CredentialGeneration: strconv.FormatInt(value.CredentialGeneration, 10),
		Runtimes:             runtimes, RuntimeDiagnostics: diagnostics, WorkspaceGrants: grants,
		LastSeenAt: value.LastSeenAt,
	}
	if value.Platform != "" {
		platform := teamhubinternal.AgentRuntimeLocalComputerPlatform(value.Platform)
		result.Platform = &platform
	}
	if value.Capacity != nil {
		capacity := int(*value.Capacity)
		result.Capacity = &capacity
	}
	return result, nil
}

func marshalRunnerProjectionArrays(runtimes any, diagnostics, grants []map[string]interface{}) (json.RawMessage, json.RawMessage, json.RawMessage, error) {
	runtimeJSON, err := json.Marshal(runtimes)
	if err != nil {
		return nil, nil, nil, err
	}
	diagnosticsJSON, err := json.Marshal(diagnostics)
	if err != nil {
		return nil, nil, nil, err
	}
	grantsJSON, err := json.Marshal(grants)
	return runtimeJSON, diagnosticsJSON, grantsJSON, err
}

func optionalInt32(value *int) *int32 {
	if value == nil {
		return nil
	}
	converted := int32(min(*value, math.MaxInt32))
	return &converted
}
