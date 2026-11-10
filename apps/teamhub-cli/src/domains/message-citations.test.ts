import { describe, expect, it } from "vitest";
import { encodeAgentCommandBody } from "../business-routes.js";

const citation = "\uE200cite\uE202turn3search9\uE201";
// Citation forms captured in the two reported Rooms, including multiple sources.
const reportedReplies = [
  "Stacked cups。\uE200cite\uE202turn0search3\uE201 Puzzle。\uE200cite\uE202turn2view1\uE201",
  "Orbit-Agent。" +
    citation +
    " openworkbuddy。\uE200cite\uE202turn3search10\uE201",
  "Sources。\uE200cite\uE202turn0search0\uE202turn0search3\uE202turn0search30\uE201",
];

const deliveries = [
  {
    name: "private",
    send: (body: string) =>
      encodeAgentCommandBody("send_direct_message", {
        messages: ["First bubble.", body],
      }),
  },
  {
    name: "sequence",
    send: (body: string) =>
      encodeAgentCommandBody("send_message_sequence", {
        inbox_id: "room_1",
        messages: [
          { content: "First bubble.", pause_before: "none" },
          { content: body, pause_before: "brief" },
        ],
      }),
  },
];

describe.each(deliveries)("$name message citations", ({ send }) => {
  it.each(reportedReplies)(
    "rejects raw citations before any publication: %s",
    async (body) => {
      await expect(send(body)).rejects.toMatchObject({
        code: "unsupported_message_citation",
        message: expect.stringContaining("No messages were sent"),
        details: { sent: false },
      });
      await expect(
        send("[Source](https://example.com/source)"),
      ).resolves.toBeDefined();
    },
  );

  it.each([
    `Inline example: \`${citation}\` and [Source](https://example.com).`,
    `Fenced example:\n\n\`\`\`text\n${citation}\n\`\`\``,
    `Tilde fence:\n\n~~~text\n${citation}\n~~~`,
    `Indented example:\n\n    ${citation}`,
    "&#xE200; is a code point without a citation sequence.",
    "Closing marker only: \uE201 and separator only: \uE202",
  ])("preserves citation syntax in Markdown code: %s", async (body) => {
    expect(JSON.stringify(await send(body))).toContain(
      JSON.stringify(body).slice(1, -1),
    );
  });

  it.each([
    `\`${citation}\` Actual source: ${citation}`,
    "&#xe200;cite&#xe202;turn1search0&#xe201;",
    "&#57856;cite&#57858;turn1search0&#57857;",
    "&#xE200;cite\uE202turn1search0\uE201",
  ])("rejects prose and Markdown-decoded markers: %s", async (body) => {
    await expect(send(body)).rejects.toMatchObject({
      code: "unsupported_message_citation",
    });
  });
});
