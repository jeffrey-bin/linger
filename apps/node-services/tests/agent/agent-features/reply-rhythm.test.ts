import { describe, expect, it } from "vitest";

import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import { createNotificationContextFeature } from "../../../src/agent/agent-features/notification-context/index.js";
import {
  createReplyRhythmFeature,
  prepareReplyRhythm,
  renderReplyRhythmDirective,
  type ReplyRhythmSettings,
} from "../../../src/agent/agent-features/reply-rhythm/index.js";
import { renderAcceptedNotification } from "../../../src/agent/prompt/accepted-notification.js";
import { mergePromptInputContribution } from "../../../src/agent/prompt/input-contribution-merger.js";
import { formatMessagesForRuntime } from "../../../src/agent/executor/run-loop.js";
import type { Message } from "../../../src/agent/executor/types.js";
import { makeTestFeatureContext } from "./fixtures.js";

const alwaysOn = {
  activationRate: 1,
  enabled: true,
  maxMessageCount: 3,
  minMessageCount: 2,
  version: "test-v1",
} satisfies ReplyRhythmSettings;

describe("reply rhythm", () => {
  it("renders an activated directive that requires sequences outside explicit exemptions", () => {
    expect(renderReplyRhythmDirective()).toContain(
      "This is an activated reply-rhythm turn",
    );
    expect(renderReplyRhythmDirective()).toContain(
      "MUST deliver the entire user-visible answer through teamhub message sequence",
    );
    expect(renderReplyRhythmDirective()).toContain(
      "rather than arbitrary sentence lengths",
    );
    expect(renderReplyRhythmDirective()).toContain(
      "Do not treat a reflective conversation",
    );
    expect(renderReplyRhythmDirective()).toContain(
      "The short bubble may appear at the beginning, middle, or end",
    );
    expect(renderReplyRhythmDirective()).toContain(
      "Do not always place the short bubble last",
    );
  });

  it("requires a structured message sequence when the current Room supports it", () => {
    const directive = renderReplyRhythmDirective({
      canSendMessageSequence: true,
      maxMessageCount: 5,
    });
    expect(directive).toContain("teamhub message sequence");
    expect(directive).toContain("ranging from 2 up to 5");
    expect(directive).toContain("For every non-exempt answer");
    expect(directive).toContain("Do not default to the minimum count");
  });

  it("offers the feature only to AnotherMe meta contexts", () => {
    expect(
      prepareReplyRhythm({
        agentId: "agent-1",
        agentType: "anotherme",
        contextRef: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
        settings: alwaysOn,
        turnKey: "room-1:4",
      }),
    ).toEqual({
      state: "offered",
      maxMessageCount: 3,
      minMessageCount: 2,
      version: "test-v1",
    });
    expect(
      prepareReplyRhythm({
        agentId: "agent-1",
        agentType: "general",
        contextRef: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
        settings: alwaysOn,
        turnKey: "room-1:4",
      }),
    ).toEqual({ state: "not_offered" });
    expect(
      prepareReplyRhythm({
        agentId: "agent-1",
        agentType: "anotherme",
        contextRef: { kind: "alter_ego", agentId: "agent-1", taskId: "task-1" },
        settings: alwaysOn,
        turnKey: "task-1:4",
      }),
    ).toEqual({ state: "not_offered" });
  });

  it("selects deterministically for the same turn", () => {
    const input = {
      agentId: "agent-1",
      agentType: "anotherme" as const,
      contextRef: {
        kind: "meta" as const,
        agentId: "agent-1",
        roomId: "room-1",
      },
      settings: { ...alwaysOn, activationRate: 0.25 },
      turnKey: "room-1:4",
    };
    expect(prepareReplyRhythm(input)).toEqual(prepareReplyRhythm(input));
  });
});

describe("reply-rhythm feature", () => {
  const acceptedPayload = {
    messageId: "notification-1",
    sourceInboxIds: ["room:room-1"],
    acceptedNotification: {
      inboxId: "room:room-1",
      cursorEncoding: "room_event_v1",
      after: "0",
      through: "1",
      messages: [
        {
          id: "human-1",
          body: "Should I change direction?",
          author: "Human",
          mentioned: true,
          teamProtocol: "fan-out-and-synthesize",
          resourceReferences: [
            { type: "document", content: "report", document_id: "doc-a" },
          ],
        },
      ],
    },
  } as const;

  const features = () => [
    createNotificationContextFeature(),
    createReplyRhythmFeature({ settings: alwaysOn }),
  ];

  it("matches only AnotherMe meta contexts", () => {
    const matched = (
      overrides?: Parameters<typeof makeTestFeatureContext>[0],
    ) =>
      composeContextFeatures({
        context: makeTestFeatureContext(overrides).context,
        features: features(),
      }).matched;
    expect(matched()).toEqual(["notification-context", "reply-rhythm"]);
    expect(
      matched({
        identity: {
          actorId: "agent-actor",
          agentType: "general",
          sponsor: { actorId: "sponsor-1", displayName: "Sponsor" },
        },
      }),
    ).toEqual(["notification-context"]);
    expect(
      matched({
        ref: { kind: "alter_ego", agentId: "agent-1", taskId: "task-1" },
      }),
    ).toEqual(["notification-context"]);
    expect(
      matched({
        ref: { kind: "document", agentId: "agent-1", documentId: "doc-1" },
      }),
    ).toEqual(["notification-context"]);
  });

  it("replays the same accepted input identically through canonical rebuild, contribution and formatting", () => {
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: features(),
      mergeInputContribution: mergePromptInputContribution,
    });
    const render = () =>
      renderAcceptedNotification(
        { ...acceptedPayload },
        composed.notificationContext,
      );
    const first = composed.prepareInput(render());
    const second = composed.prepareInput(render());

    // Same inputId -> same turnKey -> identical offered directive on replay.
    expect(second).toEqual(first);
    expect(first.rawMessage).toContain("<reply-rhythm>");
    expect(first.rawMessage.indexOf("Should I change direction?")).toBeLessThan(
      first.rawMessage.indexOf("<reply-rhythm>"),
    );
    expect(first.rawMessage.indexOf("<reply-rhythm>")).toBeLessThan(
      first.rawMessage.indexOf("Use the messages shown above"),
    );
    // Notification-context sections ride the canonical rebuild, not the
    // input contribution.
    expect(first.rawMessage).toContain(
      "Collaboration protocol published (fan-out-and-synthesize)",
    );
    // Attachments and provenance survive the contribution merge.
    expect(first.documentReferences).toEqual([{ documentId: "doc-a" }]);
    expect(first.messageId).toBe("notification-1");
    expect(first.sourceInboxIds).toEqual(["room:room-1"]);

    // The shared start/steer formatting path produces one stable text.
    const formatted = formatMessagesForRuntime([first], context.ref);
    expect(formatted).toBe(formatMessagesForRuntime([second], context.ref));
    expect(formatted).toContain("<reply-rhythm>");
    expect(formatted).toContain("Use the messages shown above");
  });

  it("appends the directive to ordinary messages without changing provenance", () => {
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: features(),
      mergeInputContribution: mergePromptInputContribution,
    });
    const original: Message = {
      messageId: "message-1",
      rawMessage: "Inbox updates are available.",
      segments: [
        { type: "text", content: "Inbox updates are available." },
        {
          type: "file",
          content: "attachment",
          document_id: "doc-1",
          document_version_id: "v-1",
        },
      ],
      sourceInboxIds: ["room-1"],
    };
    const prepared = composed.prepareInput(original);
    expect(prepared.rawMessage).toContain("<reply-rhythm>");
    expect(prepared.segments[0]).toEqual({
      type: "text",
      content: prepared.rawMessage,
    });
    expect(prepared.segments[1]).toEqual(original.segments[1]);
    expect(prepared.messageId).toBe(original.messageId);
    expect(prepared.sourceInboxIds).toEqual(original.sourceInboxIds);
  });

  it("never adds the directive to a notice steered into an active Run", () => {
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: features(),
      mergeInputContribution: mergePromptInputContribution,
    });
    const notice: Message = {
      messageId: "message-1",
      rawMessage: "Background recall for the current reply.",
      segments: [
        { type: "text", content: "Background recall for the current reply." },
      ],
      trustedNotification: true,
    };
    expect(composed.prepareInput(notice)).toBe(notice);
  });

  it("leaves the message untouched when the rhythm is not offered", () => {
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: [
        createReplyRhythmFeature({
          settings: { ...alwaysOn, activationRate: 0 },
        }),
      ],
    });
    const original: Message = {
      messageId: "message-1",
      rawMessage: "body",
      segments: [{ type: "text", content: "body" }],
    };
    expect(composed.prepareInput(original)).toBe(original);
  });
});
