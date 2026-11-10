// The Execution Context an Operation fixture runs in; one per Agent.
export const readyContextScope = (agentId = "agent-reviewer") => ({
  executionContextKey: `context-${agentId}`,
  runtimeInstanceId: `runtime-${agentId}`,
  contextViewRef: { view_digest: "a".repeat(64) },
});
