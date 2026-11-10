import { useState } from "react";

import type { TeamHubAgentReasoningEffort } from "@/features/teamhub/teamhub-types";

interface RuntimeModel {
  id: string;
  label: string;
  allowed_reasoning_effort?: readonly TeamHubAgentReasoningEffort[];
  default_reasoning_effort?: TeamHubAgentReasoningEffort;
}

/** The model and reasoning effort of a new Agent, chosen among the models the
 * selected Computer Runtime reports; the first model is the default. */
export function useAgentModelSelection(models: readonly RuntimeModel[]) {
  const [requestedModel, setRequestedModel] = useState("");
  const [requestedReasoningEffort, setRequestedReasoningEffort] = useState<
    TeamHubAgentReasoningEffort | ""
  >("");
  const selectedModel =
    models.find(({ id }) => id === requestedModel) ?? models[0];
  const reasoningEfforts = [...(selectedModel?.allowed_reasoning_effort ?? [])];
  const defaultReasoningEffort =
    selectedModel?.default_reasoning_effort &&
    reasoningEfforts.includes(selectedModel.default_reasoning_effort)
      ? selectedModel.default_reasoning_effort
      : reasoningEfforts[0];
  const reasoningEffort = reasoningEfforts.includes(
    requestedReasoningEffort as TeamHubAgentReasoningEffort,
  )
    ? (requestedReasoningEffort as TeamHubAgentReasoningEffort)
    : defaultReasoningEffort;

  return {
    items: models.map(({ id, label }) => ({ value: id, label })),
    model: selectedModel?.id ?? "",
    reasoningEffort,
    reasoningEfforts,
    selectModel: setRequestedModel,
    selectReasoningEffort: setRequestedReasoningEffort,
  };
}

export function reasoningEffortLabel(value: TeamHubAgentReasoningEffort) {
  return (
    {
      none: "None",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Maximum",
      ultra: "Ultra",
    } satisfies Record<TeamHubAgentReasoningEffort, string>
  )[value];
}
