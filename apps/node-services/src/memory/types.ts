export interface AnotherMeSubject {
  tenantId: string;
  agentActorId: string;
  agentManagementId: string;
  agentDisplayName: string;
  representedHumanActorId: string;
  representedHumanDisplayName: string;
  representedHumanAccountId: string | null;
  userProfileRevisionId?: string;
  userProfileMarkdown?: string;
  memorySubjectKey: string;
}

export interface RoomMessage {
  id: string;
  roomId: string;
  authorActorId: string;
  authorDisplayName: string;
  authorKind: "human" | "agent";
  messageKind: string;
  body: string;
  createdAt: string;
  attachments: Array<{
    documentId?: string;
    documentVersionId?: string;
    sha256?: string;
    filename: string;
    mediaType: string;
    content: string;
  }>;
}

export interface MemoryRoomSnapshot {
  tenantId: string;
  roomId: string;
  roomName: string;
  agentActorId: string;
  agentManagementId: string;
  representedHumanActorId: string;
  memorySubjectKey: string;
  relation: {
    agentIsMember: boolean;
    representedHumanIsMember: boolean;
    agentIsCreator: boolean;
    representedHumanIsCreator: boolean;
    includedBecause: Array<"agent_member" | "represented_human_member">;
  };
  messages: RoomMessage[];
}

export interface ExistingMemoryFile {
  path: string;
  content: string;
}

export interface DailyCollection {
  schemaVersion: 1;
  date: string;
  timeZone: string;
  generatedAt: string;
  source: {
    teamhubDatabaseUrlSet: boolean;
    memoryRoot: string;
  };
  subjects: AnotherMeSubject[];
  rooms: MemoryRoomSnapshot[];
  existingMemoryFiles: ExistingMemoryFile[];
}

export interface SessionlyCollection {
  schemaVersion: 1;
  date: string;
  timeZone: string;
  generatedAt: string;
  source: {
    teamhubDatabaseUrlSet: boolean;
    memoryRoot: string;
  };
  subjects: AnotherMeSubject[];
  rooms: MemoryRoomSnapshot[];
  previousSession?: ExistingMemoryFile;
  /** A Capture is a standalone source. Room data supplies authorization only. */
  recording?: RecordingSessionSource;
  sourceCursor: {
    before?: SessionlyMessageCursor;
    after: SessionlyMessageCursor;
  };
}

export interface RecordingSessionSource {
  captureId: string;
  documentId: string;
  documentVersionId: string;
  sha256: string;
  startedAt: string;
  endedAt: string;
  readyAt: string;
  /** Transcript version plus the recorder's private-context fingerprint. */
  sourceVersion?: string;
}

export interface SessionlyMessageCursor {
  messageId: string;
  createdAt: string;
}

export interface SessionlyCheckpoint {
  schemaVersion: 1;
  date: string;
  memorySubjectKey: string;
  roomId: string;
  lastMessage: SessionlyMessageCursor;
  updatedAt: string;
  recordingId?: string;
  sourceVersion?: string;
}

export interface WeeklyCollection {
  schemaVersion: 1;
  weekStart: string;
  weekEnd: string;
  timeZone: string;
  generatedAt: string;
  source: {
    memoryRoot: string;
  };
  memorySubjectKey: string;
  existingMemoryFiles: ExistingMemoryFile[];
}

export interface MemoryUpdateOutput {
  schema_version: 1;
  date: string;
  files: Array<{
    path: string;
    content: string;
    source_refs?: string[];
  }>;
  deleted_paths?: string[];
  memory_log_entries: Array<Record<string, unknown>>;
}
