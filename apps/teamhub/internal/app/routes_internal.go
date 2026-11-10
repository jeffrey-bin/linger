package app

import (
	"net/http"

	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// agentServiceRoutes mounts the teamhub-internal operations Node Services call.
func (a *App) agentServiceRoutes() []contractRoute {
	agentService := a.requireAgentService()
	memoryService := a.requireMemoryService()
	return []contractRoute{
		route(http.MethodPost, "/internal/agents/:agentId/access-credentials", nil, agentService, a.issueManagedAgentAccessCredential),
		route(http.MethodGet, "/v0/agent-runtime/agents/:agentId/memory", nil, agentService, a.getAgentMemory),
		route(http.MethodPost, "/v0/agent-runtime/agents/:agentId/memory", nil, agentService, a.commitAgentMemory),
		route(http.MethodGet, "/v0/agent-runtime/another-me-placements", teamhubinternal.ListAnotherMePlacementsParams{}, agentService, a.listAnotherMePlacements),
		route(http.MethodGet, "/v0/agent-runtime/config", teamhubinternal.GetAgentRuntimeConfigSnapshotParams{}, agentService, a.getAgentRuntimeConfigSnapshotRoute),
		route(http.MethodGet, "/v0/agent-runtime/context", teamhubinternal.GetAgentExecutionContextParams{}, agentService, a.getAgentExecutionContext),
		route(http.MethodGet, "/v0/agent-runtime/contexts", teamhubinternal.ListAgentExecutionContextsParams{}, agentService, a.listAgentExecutionContexts),
		route(http.MethodPost, "/v0/agent-runtime/contexts", nil, agentService, a.ensureAgentExecutionContext),
		route(http.MethodPost, "/v0/agent-runtime/contexts/delete", nil, agentService, a.deleteAgentExecutionContext),
		route(http.MethodPost, "/v0/agent-runtime/contexts/recently-used", nil, agentService, a.listRecentlyUsedAgentRuntimeContexts),
		route(http.MethodPost, "/v0/agent-runtime/contexts/reconcile", nil, agentService, a.reconcileAgentExecutionContexts),
		route(http.MethodPost, "/v0/agent-runtime/contexts/residency", nil, agentService, a.setAgentExecutionContextResidency),
		route(http.MethodGet, "/v0/agent-runtime/deletion-snapshot", teamhubinternal.GetAgentRuntimeDeletionSnapshotParams{}, agentService, a.getAgentRuntimeDeletionSnapshot),
		route(http.MethodPost, "/v0/agent-runtime/epochs", nil, agentService, a.startAgentServiceEpoch),
		route(http.MethodPost, "/v0/agent-runtime/human-interactions", nil, agentService, a.createRuntimeHumanInteraction),
		route(http.MethodPost, "/v0/agent-runtime/inputs/accept-trusted-notification", nil, agentService, a.acceptAgentRuntimeTrustedNotification),
		route(http.MethodGet, "/v0/agent-runtime/local-computer", teamhubinternal.GetAgentRuntimeLocalComputerParams{}, agentService, a.getAgentRuntimeLocalComputer),
		route(http.MethodPost, "/v0/agent-runtime/local-computers/connect", nil, agentService, a.connectAgentRuntimeLocalComputer),
		route(http.MethodPost, "/v0/agent-runtime/local-computers/remove", nil, agentService, a.removeAgentRuntimeLocalComputer),
		route(http.MethodPost, "/v0/agent-runtime/local-computers/touch", nil, agentService, a.touchAgentRuntimeLocalComputer),
		route(http.MethodPost, "/v0/agent-runtime/permission-reviews", nil, agentService, a.createRuntimePermissionReview),
		route(http.MethodPost, "/v0/agent-runtime/presentation-events/offer", nil, agentService, a.offerAgentRuntimePresentationEvents),
		route(http.MethodGet, "/v0/agent-runtime/run", teamhubinternal.GetAgentLocalRunParams{}, agentService, a.getAgentLocalRun),
		route(http.MethodPost, "/v0/agent-runtime/runs/cancel", nil, agentService, a.cancelAgentLocalRun),
		route(http.MethodPost, "/v0/agent-runtime/runs/claim", nil, agentService, a.claimAgentLocalRun),
		route(http.MethodPost, "/v0/agent-runtime/runs/finish", nil, agentService, a.finishAgentLocalRun),
		route(http.MethodPost, "/v0/agent-runtime/runs/operations", nil, agentService, a.recordAgentLocalRunOperation),
		route(http.MethodPost, "/v0/agent-runtime/runs/requeue", nil, agentService, a.requeueAgentLocalRun),
		route(http.MethodGet, "/v0/agent-runtime/runs/waiting", nil, agentService, a.listAgentRuntimeWaitingContexts),
		route(http.MethodGet, "/v0/agent-runtime/session", teamhubinternal.GetAgentRuntimeSessionParams{}, agentService, a.getAgentRuntimeSession),
		route(http.MethodPost, "/v0/agent-runtime/sessions/checkpoint", nil, agentService, a.checkpointAgentRuntimeSession),
		route(http.MethodPost, "/v0/agent-runtime/sessions/clear", nil, agentService, a.clearAgentRuntimeSession),
		route(http.MethodPost, "/v0/agent-runtime/statuses/open", nil, agentService, a.openAgentRuntimeStatus),
		route(http.MethodPost, "/v0/agent-runtime/steers/assign", nil, agentService, a.assignAgentRuntimeSteerRun),
		route(http.MethodPost, "/v0/agent-runtime/steers/complete", nil, agentService, a.completeAgentRuntimeSteer),
		route(http.MethodPost, "/v0/agent-runtime/steers/enqueue", nil, agentService, a.enqueueAgentRuntimeSteer),
		route(http.MethodPost, "/v0/agent-runtime/trusted-turns", nil, agentService, a.submitAgentRuntimeTrustedTurn),
		route(http.MethodGet, "/v0/agent-runtime/wakes", nil, agentService, a.streamAgentWakes),
		route(http.MethodGet, "/v0/agent-runtime/work-state", teamhubinternal.GetAgentRuntimeWorkStateParams{}, agentService, a.getAgentRuntimeWorkState),
		route(http.MethodGet, "/v0/agents/:agentId/effective-resources", nil, agentService, a.getAgentEffectiveResources),
		route(http.MethodGet, "/v0/agents/:agentId/identity", nil, agentService, a.getAgentIdentity),
		route(http.MethodGet, "/v0/agents/:agentId/participant-task:resolve", teamhubinternal.ResolveAgentParticipantTaskByWorkRoomParams{}, agentService, a.resolveAgentParticipantTaskByWorkRoom),
		route(http.MethodGet, "/v0/agents/:agentId/work-items", teamhubinternal.ListAgentWorkItemsParams{}, agentService, a.listAgentWorkItems),
		route(http.MethodPost, "/v0/agents/:agentId/work-items", teamhubinternal.CreateAgentWorkItemParams{}, agentService, a.createAgentWorkItem),
		route(http.MethodGet, "/v0/agents/:agentId/work-items/:workItemId", nil, agentService, a.getAgentWorkItem),
		route(http.MethodGet, "/v0/agents/:agentId/work-items/:workItemId/comments", teamhubinternal.ListAgentWorkItemCommentsParams{}, agentService, a.listAgentWorkItemComments),
		route(http.MethodPost, "/v0/agents/:agentId/work-items/:workItemId/comments", teamhubinternal.CreateAgentWorkItemCommentParams{}, agentService, a.createAgentWorkItemComment),
		route(http.MethodDelete, "/v0/agents/:agentId/work-items/:workItemId/comments/:commentId", teamhubinternal.DeleteAgentWorkItemCommentParams{}, agentService, a.deleteAgentWorkItemComment),
		route(http.MethodPatch, "/v0/agents/:agentId/work-items/:workItemId/comments/:commentId", teamhubinternal.UpdateAgentWorkItemCommentParams{}, agentService, a.updateAgentWorkItemComment),
		route(http.MethodPost, "/v0/agents/:agentId/work-items/:workItemId/transitions", teamhubinternal.TransitionAgentWorkItemParams{}, agentService, a.transitionAgentWorkItem),
		route(http.MethodGet, "/v0/memory/fetch_session/tenants/:tenantId/document-versions/:documentVersionId", nil, memoryService, a.fetchSession),
		route(http.MethodGet, "/v0/personal-wikis/:actorId/document-revision", teamhubinternal.GetPersonalWikiDocumentRevisionParams{}, memoryService, a.getPersonalWikiDocumentRevision),
		route(http.MethodGet, "/v0/personal-wikis/:actorId/document-revisions/:wikiRevisionId/documents/:documentId/versions/:documentVersionId/content", nil, memoryService, a.downloadPersonalWikiDocumentVersion),
		route(http.MethodPost, "/v0/personal-wikis/:actorId/memory-refresh", nil, memoryService, a.requestMemoryWikiRefresh),
		route(http.MethodPost, "/v0/rooms/:roomId/agents/:agentId/proactive/wakes", nil, agentService, a.queueProactiveWake),
		route(http.MethodPost, "/v0/rooms/:roomId/agents/:agentId/proactive/window", nil, agentService, a.getProactiveWindow),
		route(http.MethodPost, "/v0/rooms/:roomId/agents/:agentId/proactive/window/finish", nil, agentService, a.finishProactiveWindow),
		route(http.MethodGet, "/v0/rooms/:roomId/agents/:agentId/task-progress", nil, agentService, a.getTaskProgress),
		route(http.MethodPost, "/v0/task-execution-claims", nil, agentService, a.claimTaskExecution),
		route(http.MethodGet, "/v0/task-executions/:taskId", teamhubinternal.GetTaskExecutionParams{}, agentService, a.getTaskExecution),
		route(http.MethodPost, "/v0/task-executions/:taskId/heartbeat", teamhubinternal.HeartbeatTaskExecutionParams{}, agentService, a.heartbeatTaskExecution),
		route(http.MethodPost, "/v0/task-executions/:taskId/transitions", teamhubinternal.TransitionTaskExecutionParams{}, agentService, a.transitionTaskExecution),
		route(http.MethodPost, "/v0/tracking-items/:actorId/apply", nil, memoryService, a.applyMemoryTrackingItems),
		route(http.MethodPost, "/v0/tracking-items/:actorId/list", nil, memoryService, a.listMemoryTrackingItems),
		route(http.MethodPost, "/v0/tracking-items/:actorId/plan", nil, memoryService, a.planMemoryTrackingItems),
	}
}

// mcpContextRoutes mounts the teamhub-internal MCP Context operations.
func (a *App) mcpContextRoutes() []contractRoute {
	return []contractRoute{
		route(http.MethodPost, "/internal/agents/:agentId/mcp-context/actions/resolve", nil, a.resolveMcpContext),
	}
}

// voiceRuntimeRoutes mounts the teamhub-internal operations Voice Runtime calls.
func (a *App) voiceRuntimeRoutes() []contractRoute {
	return []contractRoute{
		route(http.MethodPost, "/internal/v1/voice/live-replies", nil, a.reportVoiceLiveReply),
		route(http.MethodPost, "/internal/v1/voice/live-tool-calls", nil, a.executeVoiceLiveToolCall),
		route(http.MethodPut, "/internal/v1/voice/media-objects", teamhubinternal.PutVoiceMediaObjectParams{}, a.putVoiceMediaObject),
		route(http.MethodPost, "/internal/v1/voice/observations", nil, a.reportVoiceObservationRoute),
		route(http.MethodPost, "/internal/v1/voice/recordings", nil, a.reportVoiceRecording),
		route(http.MethodGet, "/internal/v1/voice/sessions/:voiceSessionId/live-context", nil, a.getVoiceLiveContext),
		route(http.MethodGet, "/internal/v1/voice/sessions/:voiceSessionId/live-task-events", nil, a.streamVoiceLiveTaskEvents),
		route(http.MethodGet, "/internal/v1/voice/sessions/:voiceSessionId/live-tasks", nil, a.listVoiceLiveTasksRoute),
	}
}
