import type {
  components,
  operations as TeamHubPublicOperations,
} from "@linger/wire-contracts/teamhub-public/types";
import { createTeamHubAgentClient } from "./teamhub-agent-client";
import { createTeamHubApi, type TeamHubApi } from "./teamhub-api";
import {
  reportTeamHubAuthenticationRequired,
  type TeamHubAuthenticationReason,
} from "./teamhub-authentication";
import { resolveTeamHubBaseUrl } from "./teamhub-base-url";
import {
  createTeamHubDocumentLinks,
  type TeamHubDocumentLinks,
} from "./teamhub-document-links";
import { createTeamHubDocumentTransferClient } from "./teamhub-document-transfer-client";
import type { TeamHubExternalSourceClient } from "./teamhub-external-source-client";
import type { TeamHubPersonalProfileClient } from "./teamhub-personal-profile-client";
import { createTeamHubPersonalWikiClient } from "./teamhub-personal-wiki-client";
import {
  createTeamHubRoomHistory,
  type TeamHubRoomHistory,
} from "./teamhub-room-history";
import { createTeamHubRunStatusClient } from "./teamhub-run-status-client";
import type {
  TeamHubAgentSkillBinding,
  TeamHubArtifactContent,
  TeamHubArtifactContentLocation,
  TeamHubArtifactDownloadOptions,
  TeamHubArtifactRangeContent,
  TeamHubArtifactRangeOptions,
  TeamHubArtifactUploadOptions,
  TeamHubDocument,
  TeamHubDocumentUpload,
  TeamHubDocumentVersion,
  TeamHubDocumentVersionUpload,
  TeamHubLocalComputerPage,
  TeamHubMessageAttachmentUpload,
  TeamHubRunStatusList,
  TeamHubTaskActivityPage,
} from "./teamhub-types";

export { TeamHubError, TeamHubTransportError } from "./teamhub-error";

export interface TeamHubClient
  extends TeamHubExternalSourceClient, TeamHubPersonalProfileClient {
  /** The typed TeamHub API for features that call a contract path directly. */
  api: TeamHubApi;
  documentLinks: TeamHubDocumentLinks;
  roomHistory: TeamHubRoomHistory;
  getPersonalKnowledgeGraphVisualization(tenantId: string): Promise<string>;
  uploadPersonalWikiDocument(
    tenantId: string,
    input: TeamHubDocumentUpload,
    idempotencyKey: string,
    options?: TeamHubArtifactUploadOptions,
  ): Promise<TeamHubDocument>;
  uploadDocumentVersion(
    documentId: string,
    input: TeamHubDocumentVersionUpload,
    idempotencyKey: string,
    options?: TeamHubArtifactUploadOptions,
  ): Promise<TeamHubDocumentVersion>;
  downloadLatestDocument(
    documentId: string,
    options?: TeamHubArtifactDownloadOptions,
  ): Promise<TeamHubArtifactContent>;
  downloadDocumentVersion(
    documentVersionId: string,
    options?: TeamHubArtifactDownloadOptions,
  ): Promise<TeamHubArtifactContent>;
  downloadDocumentVersionRange(
    documentVersionId: string,
    options: TeamHubArtifactRangeOptions,
  ): Promise<TeamHubArtifactRangeContent>;
  getDocumentVersionContentLocation(
    documentVersionId: string,
  ): Promise<TeamHubArtifactContentLocation>;
  uploadRoomDocumentAssetContent(
    assetId: string,
    content: Blob,
  ): Promise<components["schemas"]["DocumentAsset"]>;
  uploadAgentSkillPackage(
    tenantId: string,
    agentId: string,
    file: Blob,
    fileName: string,
    key: string,
  ): Promise<TeamHubAgentSkillBinding>;
  listTenantLocalComputers(tenantId: string): Promise<TeamHubLocalComputerPage>;
  listRoomRunStatuses(roomId: string): Promise<TeamHubRunStatusList>;
  listRoomRuntimePresentationRuns(
    roomId: string,
    messageIds: readonly string[],
    runId?: string,
  ): Promise<TeamHubRunStatusList>;
  uploadMessageAttachment(
    roomId: string,
    file: File,
    idempotencyKey: string,
    options?: TeamHubArtifactUploadOptions,
  ): Promise<TeamHubMessageAttachmentUpload>;
  workItems: {
    listActivities(
      taskId: string,
      page?: TeamHubPublicOperations["listTaskRuntimePresentationRuns"]["parameters"]["query"],
      options?: { signal?: AbortSignal },
    ): Promise<TeamHubTaskActivityPage>;
  };
}

export interface HttpTeamHubClientOptions {
  baseUrl?: string;
  fetchRequest?: typeof fetch;
  onAuthenticationRequired?: (reason: TeamHubAuthenticationReason) => void;
  xhrFactory?: () => XMLHttpRequest;
}

export function createHttpTeamHubClient(
  options: HttpTeamHubClientOptions = {},
): TeamHubClient {
  const fetchRequest = options.fetchRequest ?? fetch;
  const onAuthenticationRequired =
    options.onAuthenticationRequired ?? reportTeamHubAuthenticationRequired;
  const baseUrl = resolveTeamHubBaseUrl(options.baseUrl);
  const api = createTeamHubApi({
    baseUrl,
    fetchRequest,
    onAuthenticationRequired,
  });
  const externalSources = createLazyClient(
    externalSourceClientMethods,
    async () => {
      const { createHttpTeamHubExternalSourceClient } =
        await import("./teamhub-external-source-client");
      return createHttpTeamHubExternalSourceClient(api);
    },
  );
  const personalProfile = createLazyClient(
    personalProfileClientMethods,
    async () => {
      const { createHttpTeamHubPersonalProfileClient } =
        await import("./teamhub-personal-profile-client");
      return createHttpTeamHubPersonalProfileClient(api);
    },
  );

  return {
    api,
    roomHistory: createTeamHubRoomHistory(api),
    documentLinks: createTeamHubDocumentLinks(api),
    ...externalSources,
    ...personalProfile,
    ...createTeamHubPersonalWikiClient(api),
    ...createTeamHubAgentClient(api),
    ...createTeamHubRunStatusClient(api),
    ...createTeamHubDocumentTransferClient({
      api,
      baseUrl,
      fetchRequest,
      onAuthenticationRequired,
      xhrFactory: options.xhrFactory,
    }),
  };
}

const externalSourceClientMethods = [
  "completeExternalConnectionAuthorization",
  "createExternalConnection",
  "createExternalConnectionReauthorization",
  "createExternalConnectionStatusCheck",
  "disconnectExternalConnection",
  "getExternalConnection",
  "listExternalConnections",
  "listExternalConnectionAgentAccess",
  "listExternalApps",
  "saveExternalProviderKey",
  "listDiscordChannels",
  "listGoogleCalendars",
  "listGitHubRepositories",
  "listNotionResources",
  "listSlackConversations",
  "setExternalConnectionAgentAccess",
  "setExternalConnectionAutoReminders",
] as const satisfies ReadonlyArray<keyof TeamHubExternalSourceClient>;

const personalProfileClientMethods = [
  "getPersonalProfile",
  "replacePersonalProfile",
  "listPersonalProfileGenerations",
  "createPersonalProfileGeneration",
  "listPersonalInsights",
  "deletePersonalInsight",
] as const satisfies ReadonlyArray<keyof TeamHubPersonalProfileClient>;

function createLazyClient<Client extends object>(
  methods: ReadonlyArray<keyof Client>,
  create: () => Promise<Client>,
): Client {
  let client: Promise<Client> | undefined;
  const load = () => (client ??= create());

  return Object.fromEntries(
    methods.map((method) => [
      method,
      (...args: never[]) =>
        load().then((resolved) =>
          (resolved[method] as (...values: never[]) => unknown)(...args),
        ),
    ]),
  ) as Client;
}

export function createTeamHubIdempotencyKey() {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}:${Math.random().toString(36).slice(2)}`;

  return `web:${random}`;
}
