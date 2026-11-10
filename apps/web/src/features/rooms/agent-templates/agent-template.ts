import type {
  TeamHubAgentTemplate,
  TeamHubAgentTemplatePublishInput,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import type { AgentAvatarKey } from "../members/agent-avatar";

/**
 * The portable part of an Agent: identity text, instructions, and the Skill
 * and Connector selections. Runtime provider, model, reasoning effort, and
 * Local Computer stay with the Agent because they describe where it runs, not
 * what it is.
 */
export function agentTemplateFromAgent(
  agent: TeamHubTenantAgent,
  avatarKey?: AgentAvatarKey,
  connectorKeys: readonly string[] = [],
): TeamHubAgentTemplatePublishInput {
  const avatar = avatarKey ?? agent.avatar_key;
  return {
    source_agent_actor_id: agent.actor.id,
    name: agent.actor.display_name.trim(),
    description: agent.description,
    instructions: agent.instructions,
    ...(avatar ? { avatar_key: avatar } : {}),
    // Managed platform defaults are attached by TeamHub to every new Agent, so
    // carrying them would duplicate them rather than reproduce this Agent.
    skill_bindings: agent.skill_bindings.flatMap((binding) =>
      binding.is_default
        ? []
        : [
            {
              manifest_version: binding.manifest_version,
              name: binding.name,
              skill_id: binding.skill_id,
            },
          ],
    ),
    // Only the App key travels. The publisher's connection, account and
    // credentials stay with them; whoever uses the template authorizes their
    // own accounts after the Agent exists.
    connector_bindings: [...new Set(connectorKeys)],
  };
}

export type TemplateResourceCounts = Pick<
  TeamHubAgentTemplate,
  "connector_bindings" | "skill_bindings"
> &
  Partial<Pick<TeamHubAgentTemplate, "routines">>;

/**
 * One label per resource kind the template carries, so a card can show which
 * kinds it has rather than one string that has to be read apart. Kinds the
 * template does not carry are left out entirely.
 */
export function templateResourceChips(template: TemplateResourceCounts) {
  return [
    countLabel(template.skill_bindings.length, "Skill"),
    countLabel(template.routines?.length ?? 0, "Routine"),
    countLabel(template.connector_bindings?.length ?? 0, "Connector"),
  ].filter((part) => part !== "");
}

/** Single-line summary, for places that have room for only one string. */
export function templateResourceSummary(template: TemplateResourceCounts) {
  const parts = templateResourceChips(template);
  return parts.length ? parts.join(" · ") : "Instructions only";
}

export function countLabel(total: number, noun: string) {
  if (total === 0) return "";
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}
