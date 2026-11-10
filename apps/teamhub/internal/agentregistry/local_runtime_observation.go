package agentregistry

import (
	"context"
	"encoding/json"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// LocalComputerObservationFreshness bounds how old a Computer's last_seen_at
// may be for it to count as online. Heartbeats arrive every 5s, but Agent
// Service writes last_seen_at at most every 20s. A missing heartbeat is
// evidence of a lost observation channel, not evidence that the local process
// has stopped.
const LocalComputerObservationFreshness = 60 * time.Second
const localComputerReconnectWindow = 10 * time.Minute

func (s *Service) persistedLocalAgentRuntimeStatuses(ctx context.Context, tenantID string, agents []store.ListTenantAgentsForAccountRow) map[string]roomagent.LocalAgentRuntimeStatus {
	ids := make([]string, 0, len(agents))
	for _, agent := range agents {
		ids = append(ids, agent.ActorID)
	}
	if len(ids) == 0 {
		return nil
	}
	observations, err := s.queries.ListLocalAgentComputerObservations(ctx, store.ListLocalAgentComputerObservationsParams{TenantID: tenantID, ActorIds: ids})
	if err != nil {
		s.logger.Error("read persisted Local Computer observations", "error", err)
		return nil
	}
	byActor := make(map[string]store.ListLocalAgentComputerObservationsRow, len(observations))
	for _, observation := range observations {
		byActor[observation.ActorID] = observation
	}
	result := make(map[string]roomagent.LocalAgentRuntimeStatus, len(observations))
	now := time.Now()
	for _, agent := range agents {
		if observation, ok := byActor[agent.ActorID]; ok {
			result[agent.ActorID] = projectLocalRuntimeObservation(agent, observation, now)
		}
	}
	return result
}

func projectLocalRuntimeObservation(agent store.ListTenantAgentsForAccountRow, observation store.ListLocalAgentComputerObservationsRow, now time.Time) roomagent.LocalAgentRuntimeStatus {
	result := unavailableLocalAgentRuntimeStatus(agent)
	result.DisplayName = observation.DisplayName
	if observation.LastSeenAt.Valid && !observation.LastSeenAt.Time.After(now) {
		result.ObservedAt = observation.LastSeenAt.Time
		age := now.Sub(result.ObservedAt)
		switch {
		case observation.Status == "online" && age <= LocalComputerObservationFreshness:
			result.ConnectionStatus, result.ComputerStatus = "connected", "online"
		case age <= localComputerReconnectWindow:
			result.ConnectionStatus = "reconnecting"
		case observation.Status == "offline":
			result.ConnectionStatus, result.ComputerStatus = "offline", "offline"
		}
	}
	var diagnostics []struct {
		Type    string `json:"type"`
		Status  string `json:"status"`
		Version string `json:"version"`
		Error   *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	activeDiagnostics, diagnosticsErr := agentruntimestate.ActiveLocalRuntimeDiagnostics(observation.RuntimeDiagnostics)
	if diagnosticsErr == nil && json.Unmarshal(activeDiagnostics, &diagnostics) == nil {
		for _, diagnostic := range diagnostics {
			if diagnostic.Type != result.RuntimeType {
				continue
			}
			switch diagnostic.Status {
			case "ready", "authentication_required", "not_installed", "error", "incompatible":
			default:
				continue
			}
			result.Status, result.Version = diagnostic.Status, diagnostic.Version
			result.ErrorCode, result.Message = "", ""
			if diagnostic.Error != nil {
				result.ErrorCode, result.Message = diagnostic.Error.Code, diagnostic.Error.Message
			}
			break
		}
	}
	if observation.Status == "upgrade_required" {
		result.Status, result.ErrorCode, result.Message = "incompatible", "RUNTIME_INCOMPATIBLE", "Local Computer needs an upgrade"
	}
	if result.ConnectionStatus == "offline" {
		result.Status, result.ErrorCode, result.Message = "error", "LOCAL_COMPUTER_OFFLINE", "Local Computer is offline"
	}
	return result
}
