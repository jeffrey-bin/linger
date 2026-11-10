import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { accountProfileQueryOptions } from "@/features/settings/account-profile-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { tenantAgentsQueryOptions } from "@/features/rooms/room-queries";
import type { TeamHubCurrentIdentity } from "@/features/teamhub/teamhub-types";

/**
 * Uploaded avatars by Actor. The Settings profile is the only place an avatar
 * is set, so every surface reads the picture from here instead of keeping its
 * own copy, and falls back to initials when an Actor has no uploaded picture.
 */
const ActorAvatarImageContext = createContext<ReadonlyMap<string, string>>(
  new Map(),
);

export function useActorAvatarImage(actorId?: string): string | undefined {
  const images = useContext(ActorAvatarImageContext);
  return actorId === undefined ? undefined : images.get(actorId);
}

export interface AgentAvatarRecord {
  avatarKey?: string;
  image?: string;
}

/**
 * Each Agent's avatar as TeamHub records it, so every surface and every Human
 * sees the same character or uploaded image.
 */
const AgentAvatarRecordContext = createContext<
  ReadonlyMap<string, AgentAvatarRecord>
>(new Map());

export function useAgentAvatarRecord(
  actorId?: string,
): AgentAvatarRecord | undefined {
  const records = useContext(AgentAvatarRecordContext);
  return actorId === undefined ? undefined : records.get(actorId);
}

export function ActorAvatarImageProvider({
  children,
  identity,
  tenantId,
}: {
  children: ReactNode;
  identity: TeamHubCurrentIdentity;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const { data: profile } = useQuery(
    accountProfileQueryOptions(client, tenantId),
  );
  const { data: agents } = useQuery(tenantAgentsQueryOptions(client, tenantId));
  const avatarImage = profile?.avatar_image;
  const actors = identity.actors;
  const images = useMemo(() => {
    const entries = new Map<string, string>();
    if (!avatarImage) return entries;
    for (const actor of actors) {
      entries.set(actor.id, avatarImage);
    }
    return entries;
  }, [actors, avatarImage]);

  const agentRecords = useMemo(
    () =>
      new Map(
        (agents?.items ?? []).map((agent) => [
          agent.actor.id,
          { avatarKey: agent.avatar_key, image: agent.avatar_image_url },
        ]),
      ),
    [agents],
  );

  return (
    <ActorAvatarImageContext value={images}>
      <AgentAvatarRecordContext value={agentRecords}>
        {children}
      </AgentAvatarRecordContext>
    </ActorAvatarImageContext>
  );
}
