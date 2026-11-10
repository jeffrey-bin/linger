import type { CSSProperties } from "react";

import { useAgentAvatarRecord } from "@/features/rooms/members/actor-avatar-image";
import {
  agentAvatarAppearance,
  resolveAgentAvatarKey,
} from "@/features/rooms/members/agent-avatar";

/**
 * An Agent mention takes its colour from the Agent's avatar background: the
 * name in that colour (darkened when too light to read) on a faint tint.
 */
export function useAgentMentionStyle(
  actorId: string,
  name: string,
): CSSProperties {
  const record = useAgentAvatarRecord(actorId);
  const color = agentAvatarAppearance(
    resolveAgentAvatarKey({ actorId, name, storedKey: record?.avatarKey }),
  ).color;
  return {
    "--agent-mention-color": color,
    "--agent-mention-ink": readableMentionInk(color),
  } as CSSProperties;
}

/** Light avatar backgrounds are darkened so the name keeps text contrast. */
function readableMentionInk(hex: string) {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return luminance > 0.25 ? `color-mix(in srgb, ${hex} 55%, black)` : hex;
}
