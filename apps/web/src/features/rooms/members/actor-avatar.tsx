import { useState } from "react";

import {
  useActorAvatarImage,
  useAgentAvatarRecord,
} from "./actor-avatar-image";
import { resolveAgentAvatarKey, type AgentAvatarKey } from "./agent-avatar";
import { AgentAvatarPortrait } from "./agent-avatar-portrait";

/**
 * Human initials sit on one of the palette's status tints, picked once per
 * Actor so the same person keeps the same colour everywhere.
 */
const HUMAN_AVATAR_TINTS = [
  "bg-[var(--app-accent-surface)] text-[var(--app-accent-text)]",
  "bg-[var(--app-status-success-surface)] text-[var(--app-status-success-text)]",
  "bg-[var(--app-status-warning-surface)] text-[var(--app-status-warning-text)]",
  "bg-[var(--app-status-danger-surface)] text-[var(--app-status-danger-text)]",
  "bg-[var(--app-status-neutral-surface)] text-[var(--app-status-neutral-text)]",
] as const;

function humanAvatarTint(seed: string) {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return HUMAN_AVATAR_TINTS[hash % HUMAN_AVATAR_TINTS.length]!;
}

export function ActorAvatar({
  actorId,
  animate = false,
  avatarKey,
  cheer,
  kind,
  name,
  showTitle = true,
  size = "md",
}: {
  actorId?: string;
  /** Plays an Agent figure's motion; Humans and uploaded images stay still. */
  animate?: boolean;
  avatarKey?: AgentAvatarKey | string;
  /** Each new value makes an Agent's figure lean in and smile once. */
  cheer?: number;
  kind: "agent" | "human";
  name: string;
  /** Off when a hover card already names the Actor, so no native tooltip covers it. */
  showTitle?: boolean;
  size?:
    | "card"
    | "hero"
    | "lg"
    | "md"
    | "micro"
    | "nav"
    | "rail"
    | "sm"
    | "xs"
    | "xxs";
}) {
  const sizeClass = {
    card: "size-12",
    hero: "size-36",
    lg: "size-16",
    md: "size-10",
    micro: "size-4",
    nav: "size-8",
    rail: "size-6",
    sm: "size-9",
    xs: "size-7",
    xxs: "size-5",
  }[size];
  const textSizeClass = {
    card: "text-base",
    hero: "text-4xl",
    lg: "text-lg",
    md: "text-sm",
    micro: "text-[7px]",
    nav: "text-[12px]",
    rail: "text-[9px]",
    sm: "text-xs",
    xs: "text-[10px]",
    xxs: "text-[8px]",
  }[size];
  const displayName = name.trim() || "Unknown Actor";
  const title = showTitle ? displayName : undefined;
  const uploadedImage = useActorAvatarImage(actorId);
  const agentRecord = useAgentAvatarRecord(
    kind === "agent" ? actorId : undefined,
  );
  // Fade an uploaded photo in as it paints, so it does not pop over the tint.
  const [loadedSrc, setLoadedSrc] = useState<string>();
  // Humans and Agents share one tile: the same box and the same rounded
  // square, so a mixed row of faces lines up.
  const shapeClass = "rounded-[20%]";

  if (uploadedImage && kind === "human") {
    return (
      <img
        alt={`${displayName} avatar`}
        className={`shrink-0 object-cover ${shapeClass} ${sizeClass}`}
        onLoad={() => setLoadedSrc(uploadedImage)}
        src={uploadedImage}
        style={{
          opacity: loadedSrc === uploadedImage ? 1 : 0,
          transition: "opacity 200ms ease",
        }}
        title={title}
      />
    );
  }

  if (kind === "agent") {
    const key = resolveAgentAvatarKey({
      actorId,
      avatarKey,
      name: displayName,
      storedKey: agentRecord?.avatarKey,
    });
    return (
      <span
        aria-label={`${displayName} avatar`}
        className={`block shrink-0 overflow-hidden ${shapeClass} ${sizeClass}`}
        role="img"
        title={title}
      >
        <AgentAvatarPortrait
          animate={animate}
          cheer={cheer}
          avatarKey={key}
          image={agentRecord?.image}
        />
      </span>
    );
  }

  return (
    <span
      aria-label={`${displayName} avatar`}
      className={`flex shrink-0 items-center justify-center font-semibold tracking-[0.02em] ${shapeClass} ${humanAvatarTint(actorId ?? displayName)} ${sizeClass} ${textSizeClass}`}
      role="img"
      title={title}
    >
      {actorInitials(name)}
    </span>
  );
}

/** One letter per name word, at most two: "Tony" is T, "Weihao Liu" is WL. */
function actorInitials(name: string) {
  const words = name.trim().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => [...word][0])
    .join("")
    .toUpperCase();
}
