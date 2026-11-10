import { lazy, Suspense } from "react";

import type { TeamHubMessageCard } from "@/features/teamhub/teamhub-types";

import type { RoomCardDecision } from "./room-message-card-contract";

const DecisionCard = lazy(async () => {
  const module = await import("./decision-card");
  return { default: module.DecisionCard };
});

interface RoomMessageCardProps {
  actorDisplayNames?: Readonly<Record<string, string>>;
  card: TeamHubMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
  roomId: string;
  roomMemberDecisionAllowed?: boolean;
  tenantId: string;
}

const knownCardIntents: ReadonlySet<string> = new Set([
  "decision_requested",
] satisfies TeamHubMessageCard["intent"][]);

/** A card intent this client does not know, such as one a newer TeamHub
 * added, is ignored and its Message renders as ordinary text. */
export function knownRoomMessageCard(card: TeamHubMessageCard | undefined) {
  return card && knownCardIntents.has(card.intent) ? card : undefined;
}

/** Every Room card is a decision waiting on one Human. */
export function RoomMessageCard(props: RoomMessageCardProps) {
  return (
    <Suspense fallback={null}>
      <DecisionCard {...props} />
    </Suspense>
  );
}
