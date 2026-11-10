package app

import (
	"net/http"

	"github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

// agentAPIRoutes mounts the teamhub-agent-api operations outside the CLI file
// operations.
func (a *App) agentAPIRoutes() []contractRoute {
	return []contractRoute{
		route(http.MethodPost, "/api/agent/v1/account-profile/query", nil, a.getAgentAccountProfile),
		route(http.MethodPost, "/api/agent/v1/account-profile/updates", nil, a.updateAgentAccountProfile),
		route(http.MethodPost, "/api/agent/v1/agents", nil, a.createAgent),
		route(http.MethodPost, "/api/agent/v1/agents/get", nil, a.getAgent),
		route(http.MethodPost, "/api/agent/v1/agents/updates", nil, a.updateAgent),
		route(http.MethodPost, "/api/agent/v1/apps/account", nil, a.resolveConnectorAccount),
		route(http.MethodPost, "/api/agent/v1/apps/auto-reminders/list", nil, a.listConnectorAutoReminders),
		route(http.MethodPost, "/api/agent/v1/apps/auto-reminders/set", nil, a.setConnectorAutoReminders),
		route(http.MethodPost, "/api/agent/v1/apps/connections", nil, a.listAgentConnectedApps),
		route(http.MethodPost, "/api/agent/v1/apps/files/upload-request", nil, a.prepareConnectorFileUpload),
		route(http.MethodPost, "/api/agent/v1/apps/gmail/canvas-draft", nil, a.saveConnectorGmailCanvasDraft),
		route(http.MethodPost, "/api/agent/v1/apps/mail-body", nil, a.prepareConnectorMailBody),
		route(http.MethodPost, "/api/agent/v1/apps/notion-body", nil, a.prepareConnectorNotionBody),
		route(http.MethodPost, "/api/agent/v1/apps/tools/bind", nil, a.bindConnectorTools),
		route(http.MethodPost, "/api/agent/v1/apps/tools/execute", nil, a.executeAgentConnectedAppTool),
		route(http.MethodPost, "/api/agent/v1/apps/tools/search", nil, a.searchAgentConnectedAppTools),
		route(http.MethodPost, "/api/agent/v1/available-agents", nil, a.listAvailableAgents),
		route(http.MethodPost, "/api/agent/v1/computer/browser-connection", nil, a.requestAgentBrowserConnection),
		route(http.MethodPost, "/api/agent/v1/computer/permissions/request", nil, a.requestAgentComputerPermissions),
		route(http.MethodPost, "/api/agent/v1/computer/permissions/status", nil, a.getAgentComputerPermissions),
		route(http.MethodPost, "/api/agent/v1/creation-approval-requests", nil, a.submitAgentCreationApprovalRequest),
		route(http.MethodPost, "/api/agent/v1/direct-messages", nil, a.sendAgentDirectMessage),
		route(http.MethodPost, "/api/agent/v1/document-comments/replies", nil, a.replyAgentDocumentComment),
		route(http.MethodPost, "/api/agent/v1/document-comments/text-replacements", nil, a.replaceAgentDocumentCommentText),
		route(http.MethodPost, "/api/agent/v1/document-comments/thread", nil, a.getAgentDocumentCommentThread),
		route(http.MethodPost, "/api/agent/v1/document-semantic-mutations", nil, a.applyAgentDocumentSemanticMutation),
		route(http.MethodPost, "/api/agent/v1/documents", nil, a.createAgentDocument),
		route(http.MethodPost, "/api/agent/v1/emoji-reactions", nil, a.sendAgentEmojiReaction),
		route(http.MethodPost, "/api/agent/v1/knowledge/read", nil, a.readAgentKnowledge),
		route(http.MethodPost, "/api/agent/v1/knowledge/search", nil, a.searchAgentKnowledge),
		route(http.MethodPost, "/api/agent/v1/messages/commit", nil, a.commitAgentMessage),
		route(http.MethodPost, "/api/agent/v1/messages/read", nil, a.readAgentHistoryMessages),
		route(http.MethodPost, "/api/agent/v1/messages/search", nil, a.searchAgentHistoryMessages),
		route(http.MethodPost, "/api/agent/v1/personal-profile/query", nil, a.getAgentPersonalProfile),
		route(http.MethodPost, "/api/agent/v1/personal-profile/builds", nil, a.startAgentPersonalProfileBuild),
		route(http.MethodPost, "/api/agent/v1/personal-profile/revisions", nil, a.writeAgentPersonalProfile),
		route(http.MethodPost, "/api/agent/v1/presentation-sequences", nil, a.sendAgentPresentationSequence),
		route(http.MethodPost, "/api/agent/v1/room-members/add", nil, a.addAgentRoomMember),
		route(http.MethodPost, "/api/agent/v1/room-members/query", nil, a.getAgentRoomMembers),
		route(http.MethodPost, "/api/agent/v1/routines", nil, a.createAgentRoutine),
		route(http.MethodPost, "/api/agent/v1/routines/deletion", nil, a.deleteAgentRoutine),
		route(http.MethodPost, "/api/agent/v1/routines/enable", nil, a.enableAgentRoutine),
		route(http.MethodPost, "/api/agent/v1/routines/pause", nil, a.pauseAgentRoutine),
		route(http.MethodPost, "/api/agent/v1/routines/query", nil, a.listAgentRoutines),
		route(http.MethodPost, "/api/agent/v1/routines/run", nil, a.runAgentRoutine),
		route(http.MethodPost, "/api/agent/v1/skills/packages", nil, a.publishAgentSkillPackage),
		route(http.MethodGet, "/api/agent/v1/skills/packages/:manifestId", nil, a.getAgentSkillPackage),
		route(http.MethodPost, "/api/agent/v1/tasks", nil, a.createAgentTask),
		route(http.MethodPost, "/api/agent/v1/tasks/check", nil, a.checkAgentTask),
		route(http.MethodPost, "/api/agent/v1/tasks/send", nil, a.sendAgentTask),
		route(http.MethodPost, "/api/agent/v1/tasks/stop", nil, a.stopAgentTask),
		route(http.MethodPost, "/api/agent/v1/team-md", nil, a.createAgentTeamMd),
		route(http.MethodPost, "/api/agent/v1/team-md/query", nil, a.getAgentTeamMd),
		route(http.MethodPost, "/api/agent/v1/tracking-items/add", nil, a.addAgentTrackingItem),
		route(http.MethodPost, "/api/agent/v1/tracking-items/done", nil, a.completeAgentTrackingItem),
		route(http.MethodPost, "/api/agent/v1/tracking-items/list", nil, a.listAgentTrackingItems),
		route(http.MethodPost, "/api/agent/v1/tracking-items/update", nil, a.updateAgentTrackingItem),
		route(http.MethodPost, "/api/agent/v1/user-questions", nil, a.askAgentUser),
	}
}

// agentFileRoutes mounts the CLI file operations, which answer parameter
// errors with the TeamHub error body.
func (a *App) agentFileRoutes() []contractRoute {
	return []contractRoute{
		route(http.MethodGet, "/api/agent/v1/files", teamhubagentapi.PublicListAgentCLIFilesParams{}, a.publicListAgentCLIFiles),
		route(http.MethodPost, "/api/agent/v1/files/:documentId/assets", teamhubagentapi.PublicUploadAgentCLIDocumentAssetParams{}, a.publicUploadAgentCLIDocumentAsset),
		route(http.MethodGet, "/api/agent/v1/files/:documentId/assets/:assetId/content", nil, a.publicDownloadAgentCLIDocumentAsset),
		route(http.MethodPost, "/api/agent/v1/files/:documentId/body", teamhubagentapi.PublicReplaceAgentCLIDocumentBodyParams{}, a.publicReplaceAgentCLIDocumentBody),
		route(http.MethodGet, "/api/agent/v1/files/:documentId/content", teamhubagentapi.PublicDownloadAgentCLIFileParams{}, a.publicDownloadAgentCLIFile),
		route(http.MethodPost, "/api/agent/v1/files/:documentId/link-share", nil, a.publicManageAgentCLIFileLink),
		route(http.MethodPost, "/api/agent/v1/files/:documentId/share", nil, a.publicShareAgentCLIFile),
	}
}
