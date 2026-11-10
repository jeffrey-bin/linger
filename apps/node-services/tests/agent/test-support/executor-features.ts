import {
  composeContextFeatures,
  type ComposedContextFeatures,
} from "../../../src/agent/agent-features/compose.js";
import type {
  FeatureContext,
  FeatureDeclaration,
} from "../../../src/agent/agent-features/contracts.js";
import { createNotificationContextFeature } from "../../../src/agent/agent-features/notification-context/feature.js";
import { createReplyRhythmFeature } from "../../../src/agent/agent-features/reply-rhythm/feature.js";
import type { ReplyRhythmSettings } from "../../../src/agent/agent-features/reply-rhythm/types.js";
import { createRunStatusFeature } from "../../../src/agent/agent-features/run-status/feature.js";
import type { AgentType } from "../../../src/agent/executor/types.js";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import { mergePromptInputContribution } from "../../../src/agent/prompt/input-contribution-merger.js";
import type { ExecutorFeaturePorts } from "./standalone-executor.js";

/**
 * Real Context-feature composition for executor tests: the same factories and
 * merger the builtin assembly wires, bound to a minimal honest FeatureContext.
 * Extra `declarations` append test features (via defineFeature) so throwing or
 * recording contributions still flow through the real composed ports.
 */
export const createTestFeatureAssembly = (input: {
  readonly ref: ExecutionContextRef;
  readonly actorId?: string;
  readonly agentType?: AgentType;
  readonly declarations?: readonly FeatureDeclaration[];
  readonly replyRhythmSettings?: ReplyRhythmSettings;
}): {
  readonly composed: ComposedContextFeatures;
  readonly ports: ExecutorFeaturePorts;
} => {
  const context: FeatureContext = {
    ref: input.ref,
    configurationRevision: "1",
    runtime: { type: "test" },
    identity: {
      actorId: input.actorId ?? "actor-1",
      agentType: input.agentType ?? "general",
      sponsor: { actorId: "sponsor-1", displayName: "Sponsor" },
    },
    tenantId: "tenant-1",
    actorId: input.actorId ?? "actor-1",
    agentName: "Test Agent",
    agent: { name: "Test Agent", instructions: "test instructions" },
    capabilities: ["permissionReview"],
    signal: new AbortController().signal,
    activeRunId: () => undefined,
    steer: async () => ({ status: "skipped", reason: "test context" }),
    followUp: async () => ({ status: "skipped", reason: "test context" }),
  };
  const composed = composeContextFeatures({
    context,
    features: [
      createNotificationContextFeature(),
      createReplyRhythmFeature(
        input.replyRhythmSettings === undefined
          ? undefined
          : { settings: input.replyRhythmSettings },
      ),
      createRunStatusFeature(),
      ...(input.declarations ?? []),
    ],
    mergeInputContribution: mergePromptInputContribution,
  });
  return {
    composed,
    ports: {
      prepareInput: (message) => composed.prepareInput(message),
      onRunEvent: (event) => composed.onRunEvent(event),
      notificationContext: (notificationInput) =>
        composed.notificationContext(notificationInput),
      afterInboxInputAccepted: (fact) => composed.afterInboxInputAccepted(fact),
    },
  };
};
