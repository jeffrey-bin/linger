import { describe, expect, it } from "vitest";

import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import {
  assembleExecutionContextDeveloperInstructions,
  createContextInstructionsFeature,
  type ExecutionContextDeveloperInstructionsInput,
} from "../../../src/agent/agent-features/context-instructions/index.js";
import { createToolApprovalFeature } from "../../../src/agent/agent-features/tool-approval/index.js";
import type { AgentCapability } from "../../../src/agent/executor/types.js";
import type { ExecutionContextRef } from "../../../src/agent/executor/context-ref.js";
import { makeTestFeatureContext } from "./fixtures.js";

const sponsor = { actorId: "actor:sponsor", displayName: "Test Sponsor" };
const representedHuman = {
  actorId: "actor:human",
  displayName: "Memory Owner",
  memory: {
    version: 7,
    markdown: "# Memory\n- Prefers evidence. [2026-11-01]",
  },
};

type Scene = Pick<ExecutionContextDeveloperInstructionsInput, "agentType"> &
  (
    | {
        readonly contextKind: "meta";
        readonly roomId: string;
        readonly roomKind: "direct" | "collaboration";
      }
    | { readonly contextKind: "alter_ego"; readonly taskId: string }
    | { readonly contextKind: "document" }
  );

const render = (scene: Scene): string =>
  assembleExecutionContextDeveloperInstructions({
    agentName: "Research Partner",
    agentActorId: "actor:agent-1",
    developerInstructions: undefined,
    sponsor,
    connectedApps: true,
    compactInstructions: false,
    ...(scene.agentType === "anotherme" ? { representedHuman } : {}),
    ...scene,
  });

/** The Context instructions an Agent reads, as the composed features build them. */
interface Deployment {
  readonly capabilities: readonly AgentCapability[];
  readonly connectedApps: boolean;
  /** The placed model's context window is at most 128K tokens. */
  readonly compactInstructions?: boolean;
}

/** `.env.example`: a permission judge and no Composio key. */
const defaultDeployment: Deployment = {
  capabilities: ["permissionReview"],
  connectedApps: false,
};
const fullDeployment: Deployment = {
  capabilities: ["permissionReview"],
  connectedApps: true,
};
const unconfiguredDeployment: Deployment = {
  capabilities: [],
  connectedApps: false,
};
const compactDeployment: Deployment = {
  ...fullDeployment,
  compactInstructions: true,
};

const renderComposed = (
  scene: Scene,
  deployment: Deployment,
): string | undefined => {
  const ref: ExecutionContextRef =
    scene.contextKind === "meta"
      ? { kind: "meta", agentId: "agent-1", roomId: scene.roomId }
      : scene.contextKind === "alter_ego"
        ? { kind: "alter_ego", agentId: "agent-1", taskId: scene.taskId }
        : { kind: "document", agentId: "agent-1", documentId: "document-1" };
  const { context } = makeTestFeatureContext({
    ref,
    ...(scene.contextKind === "meta" ? { roomKind: scene.roomKind } : {}),
    identity: {
      actorId: "actor:agent-1",
      agentType: scene.agentType,
      sponsor,
      ...(scene.agentType === "anotherme" ? { representedHuman } : {}),
    },
    agentName: "Research Partner",
    agent: { name: "Research Partner", instructions: "unused" },
    capabilities: deployment.capabilities,
  });
  return composeContextFeatures({
    context,
    features: [createContextInstructionsFeature(), createToolApprovalFeature()],
  }).contextInstructions({
    connectedApps: deployment.connectedApps,
    compactInstructions: deployment.compactInstructions === true,
  });
};

const meta = (
  agentType: Scene["agentType"],
  roomKind: "direct" | "collaboration",
): Scene => ({ agentType, contextKind: "meta", roomId: "room-1", roomKind });

// Each snapshot is the full prompt one identity reads; review prompt changes as
// diffs of these files rather than as substring assertions.
const scenes: readonly (readonly [string, Scene])[] = [
  ["meta-anotherme-direct", meta("anotherme", "direct")],
  ["meta-anotherme-collaboration", meta("anotherme", "collaboration")],
  ["meta-general-direct", meta("general", "direct")],
  ["meta-general-collaboration", meta("general", "collaboration")],
  [
    "alter-ego-anotherme",
    { agentType: "anotherme", contextKind: "alter_ego", taskId: "task-1" },
  ],
  [
    "alter-ego-general",
    { agentType: "general", contextKind: "alter_ego", taskId: "task-1" },
  ],
  ["document-anotherme", { agentType: "anotherme", contextKind: "document" }],
  ["document-general", { agentType: "general", contextKind: "document" }],
];

describe("execution Context instructions", () => {
  // The fully configured deployment (permission judge and Composio key).
  it.each(scenes)("renders the %s prompt", async (name, scene) => {
    await expect(renderComposed(scene, fullDeployment)).toMatchFileSnapshot(
      `./__snapshots__/context-instructions/${name}.txt`,
    );
  });

  // Neither a permission judge nor a Composio key.
  it.each(scenes)(
    "renders the %s prompt without optional features",
    async (name, scene) => {
      await expect(
        renderComposed(scene, unconfiguredDeployment),
      ).toMatchFileSnapshot(
        `./__snapshots__/context-instructions/${name}-unconfigured.txt`,
      );
    },
  );

  // A small-context model, such as a local model, reads the compact version
  // of every section.
  it.each(scenes)("renders the compact %s prompt", async (name, scene) => {
    const compact = renderComposed(scene, compactDeployment)!;
    expect(compact.length).toBeLessThan(
      renderComposed(scene, fullDeployment)!.length / 2,
    );
    await expect(compact).toMatchFileSnapshot(
      `./__snapshots__/context-instructions/${name}-compact.txt`,
    );
  });

  // Without a permission judge only the tool approval protocol is left out.
  it.each(scenes)(
    "leaves the tool approval protocol out of %s without a judge",
    (_, scene) => {
      const reviewed = renderComposed(scene, fullDeployment)!;
      const unreviewed = renderComposed(scene, {
        ...fullDeployment,
        capabilities: [],
      })!;
      expect(unreviewed).not.toContain("<tool-approval-protocol>");
      expect(unreviewed).toBe(
        reviewed.replace(
          /\n\n<tool-approval-protocol>[\s\S]*<\/tool-approval-protocol>/u,
          "",
        ),
      );
    },
  );

  // The default deployment teaches no connected app command, while Routines
  // keep their instructions.
  it.each(scenes)(
    "teaches connected apps in %s only with a Composio key",
    (_, scene) => {
      const withApps = renderComposed(scene, fullDeployment)!;
      const withoutApps = renderComposed(scene, defaultDeployment)!;
      for (const text of ["Connected app", "Connected Apps", "teamhub apps"]) {
        expect(withoutApps).not.toContain(text);
      }
      expect(withApps).toContain("Connected app");
      if (scene.contextKind !== "document") {
        expect(withoutApps).toContain("<tool-approval-protocol>");
      }
      if (scene.contextKind === "meta") {
        expect(withoutApps).toContain("- Routines:");
      }
    },
  );

  it.each(scenes)(
    "leaves memory.md to the user-memory feature for %s",
    (_, scene) => {
      const prompt = render(scene);
      expect(prompt).not.toContain("Prefers evidence");
      expect(prompt).not.toContain("profile-data");
    },
  );
});

describe("context-instructions feature", () => {
  it("contributes assembled instructions through the composed port", () => {
    const { context } = makeTestFeatureContext({
      roomKind: "direct",
      agent: { name: "Research Partner", instructions: "be helpful" },
    });
    const composed = composeContextFeatures({
      context,
      features: [createContextInstructionsFeature()],
    });
    expect(
      composed.contextInstructions({
        connectedApps: true,
        compactInstructions: false,
      }),
    ).toContain('"display_name":"Research Partner"');
  });
});
