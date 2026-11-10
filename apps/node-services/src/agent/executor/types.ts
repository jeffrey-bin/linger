export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ToolRunContext {
  readonly runId: string;
  readonly sourceInboxIds: readonly string[];
}

export type RuntimeInputProvenance = Omit<ToolRunContext, "runId">;

export type LocalTurnStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type LocalTurnTerminal =
  | { readonly type: "succeeded"; readonly finalResponse?: string }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "canceled" };

export interface LocalTurnObservation {
  readonly runId: string;
  readonly status: LocalTurnStatus;
  readonly terminal?: LocalTurnTerminal;
}

export type AgentId = string;
export type ActorId = string;
export type MessageId = string;

export type RunCancellationStatus =
  | "cancel_requested"
  | "canceled"
  | "already_terminal"
  | "not_found";

export type ContextActivity = "busy" | "idle";

export type IdleSuspendResult =
  | { readonly status: "suspended" }
  | { readonly status: "not_idle"; readonly retryAfterMs?: number };

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export interface AgentDefinition {
  name: string;
  instructions: string;
  developerInstructions?: string;
}

export type MessageSourceType = "agent" | "user";

export type MessageSegment =
  | {
      type: "text";
      content: string;
    }
  | {
      type: "html_fragment";
      content: string;
    }
  | {
      type: "reference";
      content: string;
      target: string;
      target_type: MessageSourceType;
    }
  | {
      type: "file";
      content: string;
      document_id: string;
      document_version_id: string;
    }
  | {
      type: "document";
      content: string;
      document_id: string;
      presentation?: "card" | "inline";
    }
  | {
      type: "skill";
      content: string;
      target: string;
      skill_id: string;
      manifest_version: string;
    }
  | {
      type: "artifact_tree";
      content: string;
      publication_group_id: string;
      root_path: string;
      file_count: number;
      directory_count: number;
      total_bytes: number;
      entry_document_id?: string;
      entry_document_version_id?: string;
    };

export interface Message {
  runtimeResponses?: readonly Readonly<{
    operation_id: string;
    execution_run_ref: string;
    request_id: string;
    interaction_id: string;
    payload: Record<string, unknown>;
  }>[];
  messageId: MessageId;
  invocationMessageIds?: readonly MessageId[];
  documentReferences?: readonly {
    readonly documentId: string;
    readonly documentVersionId?: string;
  }[];
  /** What TeamHub froze for the default Inbox prompt of this input. */
  notificationRender?: {
    readonly agentName: string;
    readonly triggeredAt: string;
  };
  rawMessage: string;
  segments: NonEmptyReadonlyArray<MessageSegment>;
  sourceInboxIds?: readonly string[];
  /** Persisted on notices steered into an active Local Run; not a new turn. */
  trustedNotification?: true;
}

export interface RegisteredAgent {
  agentId: AgentId;
  revision: string;
}

export interface AgentUpdateOptions {
  beforeReplacement?: () => Promise<void>;
  afterLoadedContextsDisposed?: () => Promise<void>;
}

export interface AgentSponsorIdentity {
  readonly actorId: ActorId;
  readonly displayName: string;
}

export type AgentType = "general" | "anotherme";

/** The Human's latest memory.md, maintained by Memory. */
export interface AgentUserMemory {
  readonly version: number;
  readonly markdown: string;
}

export interface AgentRepresentedHuman extends AgentSponsorIdentity {
  readonly memory?: AgentUserMemory;
}

/**
 * An optional deployment capability TeamHub reports in the Agent Runtime
 * configuration. "permissionReview": TeamHub has a Runtime permission judge.
 */
export type AgentCapability = "permissionReview";

export interface ResolvedAgentIdentity {
  readonly actorId: ActorId;
  readonly agentType: AgentType;
  readonly representedHuman?: AgentRepresentedHuman;
  readonly sponsor: AgentSponsorIdentity;
}

export interface AgentIdentityResolver {
  resolveIdentity(agentId: AgentId): Promise<ResolvedAgentIdentity>;
}

export type AgentManagerStatus =
  | "created"
  | "starting"
  | "active"
  | "suspended"
  | "stopped";
