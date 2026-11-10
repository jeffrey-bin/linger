import type { VoiceEventTransport } from "./voice-event-transport";
/* oxlint-disable react-doctor/only-export-components -- Provider, hook, runtime types, and capability policy form one context boundary; splitting them would add a pass-through module without hiding complexity. */
import { createContext, type ReactNode, useContext } from "react";

import type { TeamHubEventTransport } from "./event-transport";
import type { RunStatusTransport } from "./run-status-transport";
import type { PageActivity } from "./event-stream";
import type { TeamHubClient } from "./teamhub-client";
import type { TeamHubActorRef, TeamHubMessage } from "./teamhub-types";

export interface TeamHubCompositionAttachmentInput {
  clientId: string;
  file: File;
}

export interface TeamHubDocumentPreviewTarget {
  current_version?: { id: string };
  id: string;
  title: string;
}

export interface TeamHubPresentedAttachment {
  document: TeamHubDocumentPreviewTarget;
  available: boolean;
  filename: string;
  id: string;
  mediaType: string;
  sizeBytes: number;
}

export function presentTeamHubMessageAttachments(
  message: TeamHubMessage,
): TeamHubPresentedAttachment[] {
  return (message.attachments ?? []).map((attachment) => ({
    document: {
      current_version: { id: attachment.document_version_id },
      id: attachment.document_id,
      title: attachment.filename,
    },
    available: attachment.available,
    filename: attachment.filename,
    id: attachment.id,
    mediaType: attachment.media_type,
    sizeBytes: attachment.size_bytes,
  }));
}

export interface TeamHubMessagePresentation {
  attachments: TeamHubPresentedAttachment[];
  mentions: TeamHubActorRef[];
}

export interface TeamHubRuntime {
  client: TeamHubClient;
  documentRuntimeUrl?: string;
  runStatuses: RunStatusTransport;
  voiceEvents?: VoiceEventTransport;
  pageActivity?: PageActivity;
  events: TeamHubEventTransport;
}

const TeamHubRuntimeContext = createContext<TeamHubRuntime | null>(null);

export function TeamHubRuntimeProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: TeamHubRuntime;
}) {
  return (
    <TeamHubRuntimeContext value={runtime}>{children}</TeamHubRuntimeContext>
  );
}

export function useTeamHubRuntime() {
  const runtime = useContext(TeamHubRuntimeContext);

  if (!runtime) {
    throw new Error("TeamHub runtime is not available.");
  }

  return runtime;
}

export function useOptionalTeamHubRuntime() {
  return useContext(TeamHubRuntimeContext);
}
