import { describe, expect, it } from "vitest";

import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import {
  createRunStatusFeature,
  projectRunEventToRuntimeStatus,
  RUN_STATUS_FEATURE_ID,
} from "../../../src/agent/agent-features/run-status/index.js";
import { makeTestFeatureContext } from "./fixtures.js";

const candidate = {
  name: "Release Coordinator",
  description: "Coordinates releases.",
  instructions: "Coordinate releases.",
  skillBindings: [],
  workspaceSkillPaths: ["skill/release-check"],
  mcpBindings: [],
} as const;

const candidateResponse = {
  name: candidate.name,
  description: candidate.description,
  instructions: candidate.instructions,
  skill_bindings: [],
  workspace_skill_paths: [...candidate.workspaceSkillPaths],
  mcp_bindings: [],
} as const;

describe("projectRunEventToRuntimeStatus", () => {
  it("ignores tool results from retired Agent Build mutations", () => {
    expect(
      projectRunEventToRuntimeStatus({
        type: "tool.returned",
        callId: "call-1",
        toolName: "update_skills",
        output: {
          structuredContent: {
            build_id: "agent_build_1",
            draft_revision: 12,
            candidate: candidateResponse,
          },
        },
        isError: false,
      }),
    ).toBeNull();
  });

  it("ignores rejected or malformed Builder mutation results", () => {
    expect(
      projectRunEventToRuntimeStatus({
        type: "tool.returned",
        callId: "call-1",
        toolName: "update_name",
        output: { structuredContent: { draft_revision: 12 } },
        isError: false,
      }),
    ).toBeNull();
    expect(
      projectRunEventToRuntimeStatus({
        type: "tool.returned",
        callId: "call-2",
        toolName: "update_prompt",
        output: { draft_revision: 12, candidate },
        isError: true,
      }),
    ).toBeNull();
  });
});

describe("createRunStatusFeature", () => {
  it("projects provider events through the composed onRunEvent port", () => {
    const composed = composeContextFeatures({
      context: makeTestFeatureContext().context,
      features: [createRunStatusFeature()],
    });
    expect(composed.matched).toEqual([RUN_STATUS_FEATURE_ID]);

    expect(
      composed.onRunEvent({ type: "status.changed", status: "working" }),
    ).toEqual([{ type: "status.changed", status: "working" }]);
    expect(composed.onRunEvent({ type: "run.started" })).toEqual([]);
  });
});
