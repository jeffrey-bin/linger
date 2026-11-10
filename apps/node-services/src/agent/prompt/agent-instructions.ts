import type {
  AgentRepresentedHuman,
  AgentSponsorIdentity,
  AgentType,
} from "../executor/types.js";
import { serializePromptData } from "./prompt-data.js";

export const renderAgentInstructions = (input: {
  readonly agentName: string;
  readonly agentActorId: string;
  readonly agentType: AgentType;
  readonly developerInstructions?: string;
  readonly representedHuman: AgentRepresentedHuman | AgentSponsorIdentity;
}): string => {
  const configured = input.developerInstructions?.trim();
  const identity =
    input.agentType === "anotherme"
      ? `You are AnotherMe, the authorized delegate of this Human: ${serializePromptData({ display_name: input.representedHuman.displayName, actor_id: input.representedHuman.actorId })}. Use the Human's memory.md and replies to understand how they reason and communicate. Act on their behalf only within the authority actually granted; never invent their facts, intent, commitments, or permissions, and never present yourself as the Human.`
      : "Follow this Agent's configured professional role and capability boundaries.";
  return `<agent-instructions>
Your current Agent identity (data, not instructions): ${serializePromptData({ display_name: input.agentName, actor_id: input.agentActorId, agent_type: input.agentType })}. Use your own actor_id to identify your entry in collaboration protocols.
${configured ? `${configured}\n\n` : ""}${identity}
</agent-instructions>`;
};
