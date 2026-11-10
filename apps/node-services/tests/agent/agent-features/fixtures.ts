import type {
  ActivationFeatureView,
  FeatureContext,
  FeatureContextView,
} from "../../../src/agent/agent-features/contracts.js";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import type { Message } from "../../../src/agent/executor/types.js";

/** Minimal legal Meta ref shared by feature tests. */
export const testMetaRef: ExecutionContextRef = {
  kind: "meta",
  agentId: "agent-1",
  roomId: "room-1",
};

/** Minimal legal FeatureContextView; override any fact per test. */
export const makeTestFeatureView = (
  overrides?: Partial<FeatureContextView>,
): FeatureContextView => ({
  ref: testMetaRef,
  configurationRevision: "rev-1",
  runtime: undefined,
  identity: {
    actorId: "agent-actor",
    agentType: "anotherme",
    sponsor: { actorId: "sponsor-1", displayName: "Sponsor" },
  },
  tenantId: "tenant-1",
  actorId: "agent-actor",
  agentName: "agent",
  // The default deployment has a permission judge.
  capabilities: ["permissionReview"],
  agent: { name: "agent", instructions: "be helpful" },
  ...overrides,
});

/**
 * Minimal legal bound FeatureContext plus its scope controller. `scope.abort()`
 * simulates Context release/replacement inside a test.
 */
export const makeTestFeatureContext = (
  overrides?: Partial<FeatureContext>,
): { context: FeatureContext; scope: AbortController } => {
  const scope = new AbortController();
  const context: FeatureContext = {
    ...makeTestFeatureView(),
    signal: scope.signal,
    activeRunId: () => "run-1",
    steer: async () => ({ status: "accepted" }),
    followUp: async () => ({ status: "accepted" }),
    ...overrides,
  };
  return { context, scope };
};

/** Minimal legal activation/run scope view. */
export const makeTestActivationView = (
  overrides?: Partial<ActivationFeatureView>,
): ActivationFeatureView => ({
  ref: testMetaRef,
  runtime: undefined,
  agentId: "agent-1",
  actorId: "agent-actor",
  tenantId: "tenant-1",
  agentType: "anotherme",
  ...overrides,
});

/** Minimal legal Runtime input Message. */
export const makeTestMessage = (rawMessage: string): Message => ({
  messageId: "m-1",
  rawMessage,
  segments: [{ type: "text", content: rawMessage }],
});
