import { describe, expect, it } from "vitest";

import type { TeamHubActorRef } from "./teamhub-types";
import {
  createTeamHubMessageContent,
  formatTeamHubMentionToken,
  isTeamHubMessageContent,
  referencedMessageActors,
} from "./teamhub-message-content";

const human: TeamHubActorRef = {
  display_name: "Alice",
  id: "actor-alice",
  kind: "human",
  tenant_id: "tenant-a",
};
const agent: TeamHubActorRef = {
  display_name: "A1",
  id: "actor-a1",
  kind: "agent",
  tenant_id: "tenant-a",
};

describe("TeamHub structured Message content", () => {
  it("encodes plain text without the deprecated body request", () => {
    expect(
      createTeamHubMessageContent({
        files: [],
        mentions: [],
        text: "Ship the V0",
      }),
    ).toEqual({
      raw_message: "Ship the V0",
      segments: [{ content: "Ship the V0", type: "text" }],
    });
  });

  it("preserves ordered Human and Agent references in the exact display text", () => {
    const content = createTeamHubMessageContent({
      files: [],
      mentions: [human, agent],
      text: "@A1, ask @Alice and @A1.",
    });

    expect(content).toEqual({
      raw_message: "@A1, ask @Alice and @A1.",
      segments: [
        {
          content: "@A1",
          target: "actor-a1",
          target_type: "agent",
          type: "reference",
        },
        { content: ", ask ", type: "text" },
        {
          content: "@Alice",
          target: "actor-alice",
          target_type: "user",
          type: "reference",
        },
        { content: " and ", type: "text" },
        {
          content: "@A1",
          target: "actor-a1",
          target_type: "agent",
          type: "reference",
        },
        { content: ".", type: "text" },
      ],
    });
    expect(referencedMessageActors(content.segments, [human, agent])).toEqual([
      agent,
      human,
    ]);
  });

  it("keeps spaces in new Actor mention tokens and reads the legacy underscore form", () => {
    const spacedAgent = { ...agent, display_name: "New Agent" };
    expect(formatTeamHubMentionToken(spacedAgent)).toBe("@New Agent");

    for (const token of ["@New Agent", "@New_Agent"]) {
      expect(
        createTeamHubMessageContent({
          files: [],
          mentions: [spacedAgent],
          text: `${token} please start`,
        }).segments[0],
      ).toEqual({
        content: token,
        target: agent.id,
        target_type: "agent",
        type: "reference",
      });
    }
  });

  it("appends delivered Documents as cards while preserving exact reconstruction", () => {
    const content = createTeamHubMessageContent({
      files: [
        {
          documentId: "document-1",
          documentVersionId: "version-1",
          filename: "FILE.txt",
        },
        {
          documentId: "document-2",
          documentVersionId: "version-2",
          filename: "diagram.svg",
        },
      ],
      mentions: [agent],
      text: "@A1 please review",
    });

    expect(content.raw_message).toBe(
      "@A1 please review\nFILE.txt\ndiagram.svg",
    );
    expect(content.segments.slice(-3)).toEqual([
      {
        content: "FILE.txt",
        document_id: "document-1",
        presentation: "card",
        type: "document",
      },
      { content: "\n", type: "text" },
      {
        content: "diagram.svg",
        document_id: "document-2",
        presentation: "card",
        type: "document",
      },
    ]);
    expect(content.segments.map((segment) => segment.content).join("")).toBe(
      content.raw_message,
    );
  });

  it("encodes Document and Skill tokens at their exact text positions", () => {
    expect(
      createTeamHubMessageContent({
        documentReferences: [
          { documentId: "document-plan", token: "@Launch_plan" },
        ],
        files: [],
        mentions: [agent],
        skillReferences: [
          {
            manifestVersion: "1.0.0",
            skillId: "skill-review",
            target: agent.id,
            token: "/review",
          },
        ],
        text: "@A1 use /review on @Launch_plan",
      }).segments,
    ).toEqual([
      {
        content: "@A1",
        target: "actor-a1",
        target_type: "agent",
        type: "reference",
      },
      { content: " use ", type: "text" },
      {
        content: "/review",
        manifest_version: "1.0.0",
        skill_id: "skill-review",
        target: "actor-a1",
        type: "skill",
      },
      { content: " on ", type: "text" },
      {
        content: "@Launch_plan",
        document_id: "document-plan",
        presentation: "inline",
        type: "document",
      },
    ]);
  });

  it("structures each selected Document and Skill only once", () => {
    expect(
      createTeamHubMessageContent({
        documentReferences: [
          { documentId: "document-plan", token: "@Launch_plan" },
        ],
        files: [],
        mentions: [],
        skillReferences: [
          {
            manifestVersion: "1.0.0",
            skillId: "skill-review",
            target: agent.id,
            token: "/review",
          },
        ],
        text: "@Launch_plan then @Launch_plan /review and /review",
      }).segments,
    ).toEqual([
      {
        content: "@Launch_plan",
        document_id: "document-plan",
        presentation: "inline",
        type: "document",
      },
      { content: " then @Launch_plan ", type: "text" },
      {
        content: "/review",
        manifest_version: "1.0.0",
        skill_id: "skill-review",
        target: "actor-a1",
        type: "skill",
      },
      { content: " and /review", type: "text" },
    ]);
  });

  it("encodes the same Skill token for different Agent targets in order", () => {
    const reviewer = {
      display_name: "Reviewer",
      id: "actor-reviewer",
      kind: "agent" as const,
      tenant_id: "tenant-1",
    };
    expect(
      createTeamHubMessageContent({
        files: [],
        mentions: [agent, reviewer],
        skillReferences: [
          {
            manifestVersion: "1.0.0",
            skillId: "skill-review-a1",
            target: agent.id,
            token: "/review",
          },
          {
            manifestVersion: "2.0.0",
            skillId: "skill-review-reviewer",
            target: reviewer.id,
            token: "/review",
          },
        ],
        text: "@A1 /review @Reviewer /review",
      }).segments,
    ).toEqual([
      {
        content: "@A1",
        target: "actor-a1",
        target_type: "agent",
        type: "reference",
      },
      { content: " ", type: "text" },
      {
        content: "/review",
        manifest_version: "1.0.0",
        skill_id: "skill-review-a1",
        target: "actor-a1",
        type: "skill",
      },
      { content: " ", type: "text" },
      {
        content: "@Reviewer",
        target: "actor-reviewer",
        target_type: "agent",
        type: "reference",
      },
      { content: " ", type: "text" },
      {
        content: "/review",
        manifest_version: "2.0.0",
        skill_id: "skill-review-reviewer",
        target: "actor-reviewer",
        type: "skill",
      },
    ]);
  });

  it("accepts a contract-valid Skill Manifest build version", () => {
    const content = createTeamHubMessageContent({
      files: [],
      mentions: [agent],
      skillReferences: [
        {
          manifestVersion: "1.0.0+build.7",
          skillId: "skill-review",
          target: agent.id,
          token: "/review",
        },
      ],
      text: "@A1 /review",
    });

    expect(content.segments).toContainEqual({
      content: "/review",
      manifest_version: "1.0.0+build.7",
      skill_id: "skill-review",
      target: agent.id,
      type: "skill",
    });
  });
});

describe("TeamHub Message content validation", () => {
  it("accepts the exact show_fragment workspace path content", () => {
    const fragmentContent =
      "Visual fragment: ./inbox/task/task-alpha/.context/message-fragment/document-version-fragment/visual-fragment.html";
    expect(
      isTeamHubMessageContent(`Here is the full plan\n${fragmentContent}`, [
        { content: "Here is the full plan\n", type: "text" },
        {
          content: fragmentContent,
          html: "<main>Full plan</main>",
          type: "html_fragment",
        },
      ]),
    ).toBe(true);
  });

  it("rejects malformed structured content", () => {
    expect(
      isTeamHubMessageContent("hello", [{ content: "goodbye", type: "text" }]),
    ).toBe(false);
    expect(
      isTeamHubMessageContent("hello", [
        { content: "hello", target: "actor-a1", type: "text" },
      ]),
    ).toBe(false);
    expect(isTeamHubMessageContent(" ", [{ content: " ", type: "text" }])).toBe(
      true,
    );
  });

  it("rejects two selected Actors that collapse to the same Mention token", () => {
    expect(() =>
      createTeamHubMessageContent({
        files: [],
        mentions: [agent, { ...agent, id: "actor-a2" }],
        text: "@A1 please compare",
      }),
    ).toThrow("matches more than one Actor");
  });
});
