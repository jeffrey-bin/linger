import { isRecord } from "@linger/service-kit";

import {
  parseLocalPlacement,
  type LocalPlacementRequirement,
} from "./runner-gateway/local-computer-management.js";

export const agentReasoningEfforts = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type AgentReasoningEffort = (typeof agentReasoningEfforts)[number];

/** Every Agent runs on a Local Computer reached through the Runner Gateway. */
export interface LocalRuntimeSettings {
  type: "local";
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  placement: LocalPlacementRequirement;
}

/** Every Agent runtime carries a Local Computer placement. */
export function parseRuntimeSettings(value: unknown): LocalRuntimeSettings {
  if (!isRecord(value)) {
    throw new TypeError("runtime must be an object");
  }
  return parseLocalRuntimeSettings(value);
}

const parseLocalRuntimeSettings = (
  value: Record<string, unknown>,
): LocalRuntimeSettings => {
  const unknownKey = Object.keys(value).find(
    (key) =>
      key !== "type" &&
      key !== "model" &&
      key !== "reasoningEffort" &&
      key !== "placement",
  );
  if (unknownKey) {
    throw new TypeError(`runtime.${unknownKey} is not supported`);
  }
  const placement = parseLocalPlacement(value.placement);
  // AgentManagement carries the "codex" wire value next to a Local placement;
  // the registry projects that wire shape to the internal Local type.
  if (
    value.type !== undefined &&
    value.type !== "local" &&
    value.type !== "codex"
  ) {
    throw new TypeError(
      'Local runtime.type must be "local" or the compatible "codex" wire value',
    );
  }
  if (value.model !== undefined && typeof value.model !== "string") {
    throw new TypeError("runtime.model must be a string");
  }
  if (
    value.reasoningEffort !== undefined &&
    (typeof value.reasoningEffort !== "string" ||
      !agentReasoningEfforts.includes(
        value.reasoningEffort as AgentReasoningEffort,
      ))
  ) {
    throw new TypeError(
      `runtime.reasoningEffort must be one of ${agentReasoningEfforts.join(", ")}`,
    );
  }
  return {
    type: "local",
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: value.reasoningEffort as AgentReasoningEffort }),
    placement,
  };
};
