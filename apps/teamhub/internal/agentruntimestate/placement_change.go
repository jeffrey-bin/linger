package agentruntimestate

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var unreachableComputerTerminal = json.RawMessage(`{"type":"failed","error":"local_computer_unavailable","failure":{"code":"computer_unavailable"}}`)

// TerminateLocalWorkForUnreachableComputer ends the running Runs of an Agent
// that is moving away from a Computer that is not online: they can never
// finish there, like the Runs of an interrupted process. Queued Runs belong to
// no Computer and run on the new one after the move. A steer that waited for
// an ended Run becomes a queued Run when it is a Message and is settled as
// uncertain otherwise. It reports whether a Run ended, because that cannot be
// undone by a later rollback of the move. The caller holds the Agent
// registration lock and owns the transaction: Context locks follow the
// registration lock, and each Run's status Room follows its Context.
func TerminateLocalWorkForUnreachableComputer(ctx context.Context, queries *store.Queries, tenantID, agentActorID string) (bool, error) {
	if queries == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(agentActorID) == "" {
		return false, ErrInvalid
	}
	contextKeys, err := queries.LockOpenAgentExecutionContextsForAgentRevocation(ctx, store.LockOpenAgentExecutionContextsForAgentRevocationParams{
		TenantID: tenantID, AgentActorID: agentActorID, RoomIds: []string{},
	})
	if err != nil {
		return false, err
	}
	ended := false
	for _, contextKey := range contextKeys {
		running, err := queries.GetRunningAgentLocalRun(ctx, contextKey)
		if isNoRows(err) {
			continue
		}
		if err != nil {
			return false, err
		}
		terminated, err := TerminateLocalRuns(ctx, queries, []string{running.RunID}, unreachableComputerTerminal)
		if err != nil {
			return false, err
		}
		for _, run := range terminated {
			if err := expireRuntimeHumanInteractions(ctx, queries, run.RunID, tenantID, agentActorID); err != nil {
				return false, err
			}
			ended = true
		}
		if err := settleSteersOfInterruptedRuns(ctx, queries, contextKey); err != nil {
			return false, err
		}
	}
	return ended, nil
}
