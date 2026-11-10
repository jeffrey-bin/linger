import type { components } from "@linger/wire-contracts/teamhub-public/types";
export type TeamHubActor = components["schemas"]["Actor"];
export type TeamHubActorRef = components["schemas"]["ActorRef"];
export type TeamHubTeamMdDocument = components["schemas"]["TeamMdDocument"];
export type TeamHubTeamMdParticipant =
  components["schemas"]["TeamMdParticipant"];
export type TeamHubAgentReasoningEffort =
  components["schemas"]["AgentReasoningEffort"];
export type TeamHubRoomBackgroundTask =
  components["schemas"]["RoomBackgroundTask"];
export type TeamHubRoomRunCancelResult =
  components["schemas"]["RoomRunCancelResult"];
export type TeamHubRoomRunRedeliverResult =
  components["schemas"]["RoomRunRedeliverResult"];
export type TeamHubCreatableAgentType =
  components["schemas"]["CreatableAgentType"];
export type TeamHubMessageActivityRecord =
  components["schemas"]["MessageActivityRecord"];
export type TeamHubAnotherMe = components["schemas"]["AnotherMe"];
export type TeamHubPocketNote = components["schemas"]["PocketNote"];
export type TeamHubPocketNotePage = components["schemas"]["PocketNotePage"];
export type TeamHubLocalRuntimeType = components["schemas"]["LocalRuntimeType"];
export type TeamHubLocalComputerPage =
  components["schemas"]["LocalComputerPage"];
export type TeamHubBrowserConnectionStatus =
  components["schemas"]["BrowserConnectionStatus"];
export type TeamHubTenantAgent = components["schemas"]["TenantAgent"];
export type TeamHubTenantAgentPage = components["schemas"]["TenantAgentPage"];
export type TeamHubTenantAgentAvailabilitySnapshot =
  components["schemas"]["TenantAgentAvailabilitySnapshot"];
export type TeamHubTenantAgentCreateInput =
  components["schemas"]["TenantAgentCreateRequest"];
export type TeamHubTenantAgentUpdateInput =
  components["schemas"]["TenantAgentUpdateRequest"];
export type TeamHubAgentVisibilityScope =
  components["schemas"]["AgentVisibilityScope"];
export type TeamHubAgentSkillRegistration =
  components["schemas"]["AgentSkillRegistration"];
export type TeamHubSkillManifest = components["schemas"]["SkillManifest"];
export type TeamHubAgentTemplate = components["schemas"]["AgentTemplate"];
export type TeamHubAgentTemplatePage =
  components["schemas"]["AgentTemplatePage"];
export type TeamHubAgentTemplatePublishInput =
  components["schemas"]["AgentTemplatePublishRequest"];
export type TeamHubAgentTemplateSkillImport =
  components["schemas"]["AgentTemplateSkillImport"];
export type TeamHubDocument = components["schemas"]["Document"];
export type TeamHubDocumentShareViewV2 =
  components["schemas"]["DocumentShareViewV2"];
export type TeamHubDocumentContentRole =
  components["schemas"]["DocumentContentRoleV2"];
export type TeamHubDocumentAgentMentionCandidate =
  components["schemas"]["DocumentAgentMentionCandidateV1"];
export type TeamHubDocumentPage = components["schemas"]["DocumentPage"];
export type TeamHubDocumentHistoryContent =
  components["schemas"]["DocumentHistoryContent"];
export type TeamHubDocumentHistoryEntry =
  components["schemas"]["DocumentHistoryEntry"];
export interface TeamHubDocumentUpload {
  file: File;
  parentId?: string;
  representationFormat: string;
}
export type TeamHubDocumentVersion = components["schemas"]["DocumentVersion"];
export type TeamHubDocumentPreviewSession =
  components["schemas"]["DocumentPreviewSession"];
export interface TeamHubDocumentVersionUpload {
  linkToken?: components["schemas"]["DocumentVersionUploadRequest"]["link_token"];
  expectedCurrentVersionId: string;
  file: File;
  representationFormat: string;
}
export type TeamHubMyDocumentTree = components["schemas"]["MyDocumentTree"];
export type TeamHubDocumentPlacementFolder =
  components["schemas"]["DocumentPlacementFolder"];
export type TeamHubDocumentPlacementNode =
  components["schemas"]["DocumentPlacementNode"];
export type TeamHubDocumentTreeSummary =
  components["schemas"]["DocumentTreeSummary"];
export type TeamHubVoiceSession = components["schemas"]["VoiceSession"];
export type TeamHubVoiceMediaPolicy = components["schemas"]["VoiceMediaPolicy"];
export type TeamHubVoiceConnectionCredential =
  components["schemas"]["VoiceConnectionCredential"];
export type TeamHubVoiceCapture = components["schemas"]["VoiceCapture"];
export type TeamHubVoiceCaptureQuestion =
  components["schemas"]["VoiceCaptureQuestion"];
export type TeamHubVoiceTranscriptEvent =
  components["schemas"]["VoiceTranscriptEvent"];
export type TeamHubVoiceTranscriptEventPage =
  components["schemas"]["VoiceTranscriptEventPage"];
export type TeamHubPersonalWiki = components["schemas"]["PersonalWiki"];
export type TeamHubMemoryEntry = components["schemas"]["MemoryEntry"];
export type TeamHubExternalConnection =
  components["schemas"]["ExternalConnection"];
export type TeamHubExternalApp = components["schemas"]["ExternalApp"];
export type TeamHubExternalAppKey = components["schemas"]["ExternalAppKey"];
export type TeamHubExternalAppList = components["schemas"]["ExternalAppList"];
export type TeamHubExternalProviderKeyStatus =
  components["schemas"]["ExternalProviderKeyStatus"];
export type TeamHubExternalConnectionList =
  components["schemas"]["ExternalConnectionList"];
export type TeamHubExternalConnectionAgentAccess =
  components["schemas"]["ExternalConnectionAgentAccess"];
export type TeamHubExternalConnectionAgentAccessList =
  components["schemas"]["ExternalConnectionAgentAccessList"];
export type TeamHubDisconnectExternalConnectionInput =
  components["schemas"]["DisconnectExternalConnectionRequest"];
export type TeamHubSlackConversation =
  components["schemas"]["SlackConversation"];
export type TeamHubSlackConversationPage =
  components["schemas"]["SlackConversationPage"];
export type TeamHubDiscordChannel = components["schemas"]["DiscordChannel"];
export type TeamHubDiscordChannelList =
  components["schemas"]["DiscordChannelList"];
export type TeamHubGoogleCalendar = components["schemas"]["GoogleCalendar"];
export type TeamHubGoogleCalendarPage =
  components["schemas"]["GoogleCalendarPage"];
export type TeamHubGitHubRepository = components["schemas"]["GitHubRepository"];
export type TeamHubGitHubRepositoryPage =
  components["schemas"]["GitHubRepositoryPage"];
export type TeamHubNotionResource = components["schemas"]["NotionResource"];
export type TeamHubNotionResourcePage =
  components["schemas"]["NotionResourcePage"];
export type TeamHubPersonalProfileSourceSelection =
  components["schemas"]["PersonalProfileSourceSelection"];
export type TeamHubPersonalProfile = components["schemas"]["PersonalProfile"];
export type TeamHubPersonalProfileRevision =
  components["schemas"]["PersonalProfileRevision"];
export type TeamHubPersonalProfileDocument =
  components["schemas"]["PersonalProfileDocument"];
export type TeamHubPersonalProfileReplaceInput =
  components["schemas"]["PersonalProfileReplaceRequest"];
export type TeamHubPersonalProfileModule =
  components["schemas"]["PersonalProfileModule"];
export type TeamHubPersonalProfileTimelineEntry =
  components["schemas"]["PersonalProfileTimelineEntry"];
export type TeamHubAccountProfile = components["schemas"]["AccountProfile"];
export type TeamHubAccountProfileUpdate =
  components["schemas"]["AccountProfileUpdateRequest"];
export type TeamHubPersonalProfileGeneration =
  components["schemas"]["PersonalProfileGeneration"];
export type TeamHubPersonalProfileGenerationList =
  components["schemas"]["PersonalProfileGenerationList"];
export type TeamHubPersonalProfileGenerationCreateInput =
  components["schemas"]["PersonalProfileGenerationCreateRequest"];
export type TeamHubPersonalProfileGenerationSourceInput =
  components["schemas"]["PersonalProfileGenerationSourceInput"];
export type TeamHubPersonalInsight = components["schemas"]["PersonalInsight"];
export type TeamHubPersonalInsightList =
  components["schemas"]["PersonalInsightList"];
export type TeamHubCurrentIdentity = components["schemas"]["CurrentIdentity"];
export type TeamHubErrorResponse = components["schemas"]["ErrorResponse"];
export type TeamHubMessage = components["schemas"]["Message"];
export type TeamHubMessageReactionId =
  components["schemas"]["MessageReactionId"];
export type TeamHubMessageReaction = components["schemas"]["MessageReaction"];
export type TeamHubMessageAttachmentUpload =
  components["schemas"]["MessageAttachmentUpload"];
export type TeamHubMessageCard =
  components["schemas"]["DecisionRequestedMessageCard"];
export type TeamHubMessageCardHumanActorRef =
  components["schemas"]["MessageCardHumanActorRef"];
export type TeamHubWorkItem = components["schemas"]["WorkItem"];
export type TeamHubWorkItemPage = components["schemas"]["WorkItemPage"];
export type TeamHubTaskExecution =
  components["schemas"]["TaskExecutionProjection"];
export type TeamHubTaskActivityPage = Omit<
  components["schemas"]["TaskRuntimePresentationRunPage"],
  "active_items" | "history_items"
> & {
  active_items: TeamHubRunStatus[];
  history_items: TeamHubRunStatus[];
};
export type TeamHubRoutine = components["schemas"]["Routine"];
export type TeamHubRoutineCadence = components["schemas"]["RoutineCadence"];
/** A Routine on a cadence; an app listener Routine has none. */
export type TeamHubScheduledRoutine = TeamHubRoutine & {
  cadence: TeamHubRoutineCadence;
};
export type TeamHubMessageCreateInput =
  components["schemas"]["MessageCreateRequest"];
export type TeamHubMessageFileSegment = components["schemas"]["FileSegment"];
export type TeamHubMessageArtifactTreeSegment =
  components["schemas"]["ArtifactTreeSegment"];
export type TeamHubMessageHtmlFragmentSegment =
  components["schemas"]["HtmlFragmentSegment"];
export type TeamHubMessageDocumentSegment =
  components["schemas"]["DocumentSegment"];
export type TeamHubMessageSegment = components["schemas"]["MessageSegment"];
export type TeamHubMessagePage = components["schemas"]["MessagePage"];
export type TeamHubMessageSearchHit = components["schemas"]["MessageSearchHit"];
export type TeamHubMessageThreadSummary =
  components["schemas"]["MessageThreadSummary"];
export type TeamHubRoomRunStatus = components["schemas"]["RoomRunStatus"];
/**
 * A Run status as the Room UI keys it: id is the Run ID, and revision is the
 * Run's last event ordinal, which only grows.
 */
export interface TeamHubRunStatus {
  id: string;
  run_id: string;
  room_id: string;
  agent: TeamHubRoomRunStatus["agent"];
  status: TeamHubRoomRunStatus["status"];
  /** TeamHub's judgment that an active Run's Agent has replied and is no longer working. */
  replied: boolean;
  revision: number;
  stop_reason?: string;
  created_at: string;
  updated_at: string;
}
export interface TeamHubRunStatusList {
  items: TeamHubRunStatus[];
}
export type TeamHubRuntimePresentationEventRecord =
  components["schemas"]["RuntimePresentationEventRecord"];
export type TeamHubRuntimePresentationEventPage =
  components["schemas"]["RuntimePresentationEventPage"];

export type TeamHubRoom = components["schemas"]["Room"];
export type TeamHubDocumentOpenResult =
  components["schemas"]["DocumentOpenResult"];
export type TeamHubRoomDocumentAsset = components["schemas"]["DocumentAsset"];
export type TeamHubRoomDocumentAssetUploadInput =
  components["schemas"]["DocumentAssetUploadRequest"];
export type TeamHubDocumentComment = components["schemas"]["DocumentComment"];
export type TeamHubDocumentCommentAnchorInput =
  components["schemas"]["DocumentCommentAnchorInput"];
export type TeamHubDocumentCommentDurableHead =
  components["schemas"]["DocumentCommentDurableHeadSelector"];
export type TeamHubDocumentCommentCurrentContext =
  components["schemas"]["DocumentCommentCurrentContextSelector"];
export type TeamHubDocumentCommentReplyInput =
  components["schemas"]["DocumentCommentReplyCreateRequest"];
export type TeamHubDocumentCommentThread =
  components["schemas"]["DocumentCommentThread"];
export type TeamHubDocumentCommentThreadCreateInput =
  components["schemas"]["DocumentCommentThreadCreateRequest"];
export type TeamHubDocumentCommentThreadResolutionInput =
  components["schemas"]["DocumentCommentThreadResolutionRequest"];
export type TeamHubDocumentCommentUpdateInput =
  components["schemas"]["DocumentCommentUpdateRequest"];
export type TeamHubDocumentCommentVersionInput =
  components["schemas"]["DocumentCommentVersionRequest"];
export type TeamHubRoomListItem = components["schemas"]["RoomListItem"];
export type TeamHubRoomCreateInput =
  components["schemas"]["HumanRoomCreateRequest"];
type TeamHubGeneratedRoomEvent = components["schemas"]["RoomEventEnvelope"];
type TeamHubRoomSnapshotPayload = Omit<
  components["schemas"]["RoomSnapshotPayload"],
  "kind"
> & { kind: "room.created" | "room.updated" };
type TeamHubRoomDeletedPayload = Omit<
  components["schemas"]["RoomDeletedPayload"],
  "kind"
> & { kind: "room.deleted" };
type TeamHubRoomHistoryCompactedPayload = Omit<
  components["schemas"]["RoomHistoryCompactedPayload"],
  "kind"
> & { kind: "room.history.compacted" };
type TeamHubMessageSnapshotPayload = Omit<
  components["schemas"]["MessageSnapshotPayload"],
  "kind"
> & { kind: "message.created" };
type TeamHubMessageHiddenPayload = Omit<
  components["schemas"]["MessageHiddenPayload"],
  "kind"
> & { kind: "message.hidden" };
type TeamHubMessageThreadSummaryUpdatedPayload = Omit<
  components["schemas"]["MessageThreadSummaryUpdatedPayload"],
  "kind"
> & { kind: "message.thread_summary.updated" };
type TeamHubMessageReactionsChangedPayload = Omit<
  components["schemas"]["MessageReactionsChangedPayload"],
  "kind"
> & { kind: "message.reactions.changed" };
type TeamHubCardChangedPayload = Omit<
  components["schemas"]["CardChangedPayload"],
  "kind"
> & { kind: "card.changed" };
type TeamHubRoomDocumentChangedPayload = Omit<
  components["schemas"]["RoomDocumentChangedPayload"],
  "kind"
> & { kind: "document.created" };
type TeamHubRoomMemberSnapshotPayload = Omit<
  components["schemas"]["RoomMemberSnapshotPayload"],
  "kind"
> & {
  kind:
    | "room.member.added"
    | "room.member.removed"
    | "room.member.role_changed";
};
type TeamHubWorkItemChangedPayload = Omit<
  components["schemas"]["WorkItemChangedPayload"],
  "kind"
> & { kind: "work_item.changed" };
type TeamHubDocumentCommentChangedPayload = Omit<
  components["schemas"]["DocumentCommentChangedPayload"],
  "kind"
> & { kind: "document.comment.changed" };
type TeamHubRoutineChangedPayload = Omit<
  components["schemas"]["RoutineChangedPayload"],
  "kind"
> & { kind: "routine.changed" };
type TeamHubCaptureSessionChangedPayload = Omit<
  components["schemas"]["CaptureSessionChangedPayload"],
  "kind"
> & { kind: "capture.session.changed" };
type TeamHubAgentRunStatusChangedPayload = Omit<
  components["schemas"]["AgentRunStatusChangedPayload"],
  "kind"
> & { kind: "agent_run.status_changed" };
type TeamHubTeamMdPublishedPayload = Omit<
  components["schemas"]["TeamMdPublishedPayload"],
  "kind"
> & { kind: "team_md.published" };

// openapi-typescript rewrites discriminator values to schema names. TeamHub's
// wire contract uses semantic event names, so keep that correction in one type.
export type TeamHubRoomEvent = Omit<TeamHubGeneratedRoomEvent, "payload"> & {
  payload:
    | TeamHubRoomDocumentChangedPayload
    | TeamHubCardChangedPayload
    | TeamHubWorkItemChangedPayload
    | TeamHubDocumentCommentChangedPayload
    | TeamHubMessageSnapshotPayload
    | TeamHubMessageHiddenPayload
    | TeamHubMessageThreadSummaryUpdatedPayload
    | TeamHubMessageReactionsChangedPayload
    | TeamHubRoomHistoryCompactedPayload
    | TeamHubRoomMemberSnapshotPayload
    | TeamHubRoomDeletedPayload
    | (Omit<
        components["schemas"]["RoomParticipationChangedPayload"],
        "kind"
      > & { kind: "room.participation.changed" })
    | TeamHubRoomSnapshotPayload
    | TeamHubWorkItemChangedPayload
    | TeamHubRoutineChangedPayload
    | TeamHubCaptureSessionChangedPayload
    | TeamHubAgentRunStatusChangedPayload
    | TeamHubTeamMdPublishedPayload;
};
export type TeamHubRoomMember = components["schemas"]["RoomMember"];
export type TeamHubRoomMemberPage = components["schemas"]["RoomMemberPage"];
export type TeamHubRoomPage = components["schemas"]["RoomPage"];
export type TeamHubRoomUpdateInput = components["schemas"]["RoomUpdateRequest"];
export type TeamHubSession = components["schemas"]["Session"];
export type TeamHubTenant = components["schemas"]["Tenant"];
// The /v0/events hint and resync payloads. The SSE event schemas
// are not referenced by a path response, so the generator emits no type.
export type TeamHubInvalidationResource =
  | "room"
  | "directory"
  | "agents"
  | "another-me"
  | "computers"
  | "connections"
  | "work-items"
  | "document"
  | "document-access";
export interface TeamHubResourceInvalidation {
  id: string;
  resource: TeamHubInvalidationResource;
  room_seq?: number;
  tenant_id: string;
}

export interface TeamHubPageInput {
  cursor?: string;
  limit?: number;
}

export interface TeamHubArtifactUploadOptions {
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TeamHubArtifactDownloadOptions {
  expectedSizeBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TeamHubArtifactContent {
  blob: Blob;
  mediaType: string;
  sha256?: string;
}

export type TeamHubArtifactRangeOptions = TeamHubArtifactDownloadOptions & {
  endInclusive: number;
  expectedSha256: string;
  expectedTotalSize: number;
  start?: number;
};

export interface TeamHubArtifactRangeContent {
  blob: Blob;
  endInclusive: number;
  mediaType: string;
  start: number;
  totalSize: number;
}

export interface TeamHubArtifactContentLocation {
  dispose: () => void;
  url: string;
}

export type TeamHubVoiceEventPage = components["schemas"]["VoiceEventPage"];

export type TeamHubAgentSkillBinding =
  components["schemas"]["AgentSkillBinding"];

export type TeamHubVoiceLiveTurnMarker =
  components["schemas"]["VoiceLiveTurnMarker"];
export type TeamHubVoiceLiveClientEvent =
  components["schemas"]["VoiceLiveClientEvent"];
export type TeamHubVoiceLiveRuntimeEvent =
  components["schemas"]["VoiceLiveRuntimeEvent"];
