import { describe, expect, it } from "vitest";

import {
  historyPairs,
  localTimeRule,
  pageChainRule,
  realtimeInstructions,
} from "./realtime.js";

describe("realtime history", () => {
  it("keeps history as bounded user/assistant pairs", () => {
    expect(
      historyPairs([
        { role: "user", text: "a" },
        { role: "user", text: "b" },
        { role: "assistant", text: " " },
        { role: "assistant", text: "c" },
      ]),
    ).toEqual([
      { role: "user", text: "a\nb" },
      { role: "assistant", text: "c" },
    ]);
    const long = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      text: String(index),
    }));
    const pairs = historyPairs(long);
    expect(pairs).toHaveLength(40);
    expect(pairs[0]).toEqual({ role: "user", text: "20" });
  });
});

describe("realtime page chain rule", () => {
  it("chains page_action steps only when the model has the tool", () => {
    const own = pageChainRule([{ name: "read_page" }, { name: "page_action" }]);
    expect(own).toContain("one page_action per step");
    expect(own).toContain("confirmed=true");
    expect(pageChainRule([{ name: "read_page" }])).toBe("");
  });
});

describe("realtime session rules", () => {
  it("follows the persona with one place per kind of request and the absolute rules", () => {
    const rules = realtimeInstructions("## Role & Persona\nbase", [
      { name: "page_action" },
    ]);
    // The persona leads; the language and length rules are absolute rules.
    expect(rules.startsWith("## Role & Persona")).toBe(true);
    expect(rules).toContain(
      "\n- LANGUAGE: Speak only the language of the user's latest words.",
    );
    expect(rules).toContain("\n- LENGTH: ");
    expect(rules.indexOf("## Conversation Flow")).toBeLessThan(
      rules.indexOf("## CRITICAL INSTRUCTIONS"),
    );
    for (const want of [
      "recall_memory, also when that page is open on the screen",
      "It reaches nothing outside this app",
      "surface web for websites",
      "desktop for apps and files on their computer",
      "reply_to_task",
      "cancel_task",
      "list_tasks",
      "never ask whether they are sure",
    ])
      expect(rules).toContain(want);
    expect(rules).not.toContain("delegate_to_agent");
  });

  it("routes new documents, routines, Agents and Slack sends to their own tools only when offered", () => {
    const rules = realtimeInstructions("base", [
      { name: "create_document" },
      { name: "edit_document" },
      { name: "create_routine" },
      { name: "list_routines" },
      { name: "change_routine" },
      { name: "create_agent" },
      { name: "search_slack" },
      { name: "slack_inbox" },
      { name: "send_slack" },
    ]);
    for (const want of [
      "create_document, written from what they said",
      "create_routine; which ones exist is list_routines",
      "with no phone notification",
      "create_agent, with complete instructions",
      "slack_inbox for what came to them",
      "Sending a Slack message is send_slack",
      "Slack is send_slack, and replying or posting in Feishu",
    ])
      expect(rules).toContain(want);
    const without = realtimeInstructions("base", [{ name: "search_slack" }]);
    for (const tool of [
      "create_document",
      "create_routine",
      "create_agent",
      "send_slack",
    ])
      expect(without).not.toContain(tool);
    expect(without).toContain("replying or posting in Slack, Feishu");
  });

  it("answers live facts with web_search only when it is offered", () => {
    expect(realtimeInstructions("base", [{ name: "web_search" }])).toContain(
      "web_search on the spot",
    );
    expect(realtimeInstructions("base", [])).not.toContain("web_search");
  });
});

describe("localTimeRule", () => {
  it("gives the process-zone date and flags the hours after midnight", () => {
    const rule = localTimeRule(new Date("2026-10-14T16:34:00Z"));
    expect(rule).toContain("2026-10-15 00:34");
    expect(rule).toContain("Asia/Shanghai, UTC+8");
    expect(rule).toContain("Thursday");
    expect(rule).toContain("past midnight");
    expect(localTimeRule(new Date("2026-10-15T02:00:00Z"))).not.toContain(
      "past midnight",
    );
  });
  it("routes named websites to the local browser only when it is offered", () => {
    const withBrowser = realtimeInstructions("base", [
      { name: "web_search" },
      { name: "computer_browser" },
    ]);
    expect(withBrowser).toContain("a site they name");
    expect(withBrowser).toContain("that is computer_browser");
    const without = realtimeInstructions("base", [{ name: "web_search" }]);
    expect(without).not.toContain("computer_browser");
  });
});
