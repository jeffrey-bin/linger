import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageMarkdown } from "./message-markdown";
import type { TeamHubMessageSegment } from "@/features/teamhub/teamhub-types";

describe("Message Markdown", () => {
  it("uses the same presentation class for Human and Agent messages", () => {
    const { container } = render(
      <>
        <MessageMarkdown authorKind="human" body="Human message" />
        <MessageMarkdown authorKind="agent" body="Agent message" />
      </>,
    );

    const messages = [...container.querySelectorAll(".message-markdown")];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toHaveClass("message-markdown");
    expect(messages[1]).toHaveClass("message-markdown");
    expect(messages[0]).not.toHaveClass("agent-reply-markdown");
  });

  it("preserves Human soft line breaks alongside inline Markdown", () => {
    const { container } = render(
      <MessageMarkdown
        authorKind="human"
        body={"First line\n**Second line**\nThird line"}
      />,
    );
    expect(container.querySelectorAll("br")).toHaveLength(2);
    expect(container.querySelector("p")).not.toHaveClass("whitespace-pre-wrap");
    expect(container.querySelector("p")?.textContent).toBe(
      "First line\nSecond line\nThird line",
    );
    expect(screen.getByText("Second line").tagName).toBe("STRONG");
  });

  it.each(["first  \nsecond", "first\\\nsecond"])(
    "preserves a single Human hard break: %s",
    (body) => {
      const { container } = render(
        <MessageMarkdown authorKind="human" body={body} />,
      );
      expect(container.querySelectorAll("br")).toHaveLength(1);
      expect(container.querySelector("p")).not.toHaveClass(
        "whitespace-pre-wrap",
      );
    },
  );

  it("shows unavailable source labels for legacy Agent citations and keeps code and links", () => {
    const marker = "\uE200cite\uE202turn3search9\uE201";
    const multiple = "\uE200cite\uE202turn0search0\uE202turn0search3\uE201";
    const { container } = render(
      <MessageMarkdown
        authorKind="agent"
        body={`**Orbit-Agent** ${marker}\n\n[Source](https://example.com) ${multiple}\n\nSyntax: \`${marker}\`\n\n~~~text\n${marker}\n~~~`}
      />,
    );
    expect(screen.getAllByText("Source link unavailable")).toHaveLength(2);
    for (const label of screen.getAllByText("Source link unavailable")) {
      expect(label).toHaveClass("text-app-muted");
    }
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(container.querySelector("strong")).toHaveTextContent("Orbit-Agent");
    expect(container.querySelectorAll("code")).toHaveLength(2);
    for (const code of container.querySelectorAll("code"))
      expect(code).toHaveTextContent(marker);
    expect(container.textContent?.split(marker)).toHaveLength(3);
  });

  it("does not rewrite literal citations in Human messages", () => {
    const marker = "\uE200cite\uE202turn2view1\uE201";
    const { container } = render(
      <MessageMarkdown authorKind="human" body={marker} />,
    );
    expect(container).toHaveTextContent(marker);
    expect(
      screen.queryByText("Source link unavailable"),
    ).not.toBeInTheDocument();
  });

  it("keeps structured Actor and Document references next to legacy citations actionable", () => {
    const onOpenActor = vi.fn();
    const onOpenDocument = vi.fn();
    const document = {
      type: "document" as const,
      content: "#Plan",
      document_id: "plan",
    };
    const segments: TeamHubMessageSegment[] = [
      { type: "text", content: "Source。\uE200cite\uE202turn2view0\uE201" },
      {
        type: "reference",
        content: "@Alice",
        target: "alice",
        target_type: "user",
      },
      { type: "text", content: " see #Plan" },
    ];
    render(
      <MessageMarkdown
        authorKind="agent"
        body={segments.map((segment) => segment.content).join("")}
        segments={segments}
        documentReferences={[document]}
        onOpenActor={onOpenActor}
        onOpenDocument={onOpenDocument}
      />,
    );
    expect(screen.getByText("Source link unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "@Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Plan" }));
    expect(onOpenActor).toHaveBeenCalledWith("alice");
    expect(onOpenDocument).toHaveBeenCalledWith(document);
  });

  it("updates reference actions and titles while the Markdown body stays unchanged", () => {
    const segments: TeamHubMessageSegment[] = [
      {
        type: "reference",
        content: "@Alice",
        target: "alice",
        target_type: "user",
      },
      { type: "text", content: " read #Plan" },
    ];
    const documents = [
      { type: "document" as const, content: "#Plan", document_id: "plan" },
    ];
    const oldActor = vi.fn();
    const nextActor = vi.fn();
    const oldDocument = vi.fn();
    const nextDocument = vi.fn();
    const view = render(
      <MessageMarkdown
        authorKind="human"
        body="@Alice read #Plan"
        segments={segments}
        documentReferences={documents}
        documentTitles={{ plan: "Old title" }}
        onOpenActor={oldActor}
        onOpenDocument={oldDocument}
      />,
    );
    view.rerender(
      <MessageMarkdown
        authorKind="human"
        body="@Alice read #Plan"
        segments={segments}
        documentReferences={documents}
        documentTitles={{ plan: "New title" }}
        onOpenActor={nextActor}
        onOpenDocument={nextDocument}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "@Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "Open New title" }));
    expect(nextActor).toHaveBeenCalledWith("alice");
    expect(nextDocument).toHaveBeenCalledWith(documents[0]);
    expect(oldActor).not.toHaveBeenCalled();
    expect(oldDocument).not.toHaveBeenCalled();
  });

  it("keeps literal text that resembles an internal mention token unchanged", () => {
    render(
      <MessageMarkdown
        authorKind="agent"
        body="LINGERMENTION0END lu"
        segments={[
          { type: "text", content: "LINGERMENTION0END " },
          {
            type: "reference",
            content: "lu",
            target: "actor-lu",
            target_type: "user",
          },
        ]}
        onOpenActor={vi.fn()}
      />,
    );
    expect(screen.getByText(/LINGERMENTION0END/)).toHaveTextContent(
      "LINGERMENTION0END @lu",
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("renders only the structured occurrence of an Agent reference without an at prefix", () => {
    const onOpenActor = vi.fn();
    const segments: TeamHubMessageSegment[] = [
      { type: "text", content: "lu has reviewed the list. Please check, " },
      {
        type: "reference",
        content: "lu",
        target: "actor-lu",
        target_type: "user",
      },
      { type: "text", content: ". The word blue stays plain." },
    ];
    render(
      <MessageMarkdown
        authorKind="agent"
        body={segments.map((segment) => segment.content).join("")}
        segments={segments}
        onOpenActor={onOpenActor}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "@lu" }));
    expect(onOpenActor).toHaveBeenCalledWith("actor-lu");
    expect(screen.getByText(/lu has reviewed the list/)).toHaveTextContent(
      "lu has reviewed the list. Please check, @lu. The word blue stays plain.",
    );
  });

  it.each(["\n", "\r\n", "\u2028", "\u2029"])(
    "renders body-sized references as Markdown instead of a mention (%j)",
    (lineBreak) => {
      const content = `**Review**${lineBreak}${lineBreak}Keep the original text.`;
      const segments: TeamHubMessageSegment[] = [
        {
          type: "reference",
          content,
          target: "actor-review",
          target_type: "agent",
        },
        { type: "text", content: "\n\nReviewed by " },
        {
          type: "reference",
          content: "@Alex Doe",
          target: "actor-lu",
          target_type: "user",
        },
      ];
      const originalSegments = structuredClone(segments);
      const onOpenActor = vi.fn();
      const { container } = render(
        <MessageMarkdown
          authorKind="agent"
          body={segments.map((segment) => segment.content).join("")}
          segments={segments}
          onOpenActor={onOpenActor}
        />,
      );

      expect(screen.getByText("Review").tagName).toBe("STRONG");
      expect(container).toHaveTextContent("Keep the original text.");
      expect(container).not.toHaveTextContent("**Review**");
      expect(screen.getAllByRole("button")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "@Alex Doe" }));
      expect(onOpenActor).toHaveBeenCalledWith("actor-lu");
      expect(segments).toEqual(originalSegments);
    },
  );

  it("renders overlong single-line reference content in full without an invented at prefix", () => {
    const content = "**Review** " + "original evidence ".repeat(20) + "End.";
    const { container } = render(
      <MessageMarkdown
        authorKind="agent"
        body={content}
        segments={[
          {
            type: "reference",
            content,
            target: "actor-review",
            target_type: "agent",
          },
        ]}
        onOpenActor={vi.fn()}
      />,
    );

    expect(screen.getByText("Review").tagName).toBe("STRONG");
    expect(container.textContent).toBe(content.replaceAll("**", ""));
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("mark")).toBeNull();
  });

  it("keeps maximum-length Unicode Actor names actionable", () => {
    const content = "@" + "🧑".repeat(120);
    const onOpenActor = vi.fn();
    render(
      <MessageMarkdown
        authorKind="agent"
        body={content}
        segments={[
          {
            type: "reference",
            content,
            target: "actor-review",
            target_type: "agent",
          },
        ]}
        onOpenActor={onOpenActor}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: content }));
    expect(onOpenActor).toHaveBeenCalledWith("actor-review");
  });

  it("retains the Markdown safety boundary for malformed references", () => {
    const content =
      "**Review**\n\n[unsafe](javascript:alert(1))\n\n<script>window.evil = true</script>";
    const { container } = render(
      <MessageMarkdown
        authorKind="agent"
        body={content}
        segments={[
          {
            type: "reference",
            content,
            target: "actor-review",
            target_type: "agent",
          },
        ]}
      />,
    );
    expect(screen.getByText("Review").tagName).toBe("STRONG");
    expect(screen.getByText("unsafe").closest("a")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container).not.toHaveTextContent("window.evil");
  });

  it("keeps duplicate and renamed mention labels bound to their own Actor IDs", () => {
    const onOpenActor = vi.fn();
    const segments: TeamHubMessageSegment[] = [
      {
        type: "reference",
        content: "@Reviewer",
        target: "actor-first",
        target_type: "user",
      },
      { type: "text", content: " and " },
      {
        type: "reference",
        content: "@Reviewer",
        target: "actor-second",
        target_type: "agent",
      },
    ];
    render(
      <MessageMarkdown
        authorKind="agent"
        body="@Reviewer and @Reviewer"
        segments={segments}
        mentions={[
          {
            display_name: "Renamed reviewer",
            id: "actor-first",
            kind: "human",
            tenant_id: "tenant-1",
          },
        ]}
        onOpenActor={onOpenActor}
      />,
    );

    const buttons = screen.getAllByRole("button", { name: "@Reviewer" });
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(onOpenActor.mock.calls).toEqual([["actor-first"], ["actor-second"]]);
  });

  it("preserves Markdown formatting and leaves references inside code and external links inert", () => {
    const segments: TeamHubMessageSegment[] = [
      { type: "text", content: "**" },
      {
        type: "reference",
        content: "Reviewer [one]",
        target: "actor-review",
        target_type: "agent",
      },
      { type: "text", content: "** and `" },
      {
        type: "reference",
        content: "lu",
        target: "actor-lu",
        target_type: "user",
      },
      { type: "text", content: "` or [" },
      {
        type: "reference",
        content: "lu",
        target: "actor-lu",
        target_type: "user",
      },
      { type: "text", content: "](https://example.com)." },
    ];
    const { container } = render(
      <MessageMarkdown
        authorKind="agent"
        body={segments.map((segment) => segment.content).join("")}
        segments={segments}
        onOpenActor={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "@Reviewer [one]" }).closest("strong"),
    ).not.toBeNull();
    expect(container.querySelector("code")).toHaveTextContent("lu");
    expect(screen.getByRole("link", { name: "lu" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("renders the Human subset without authored HTML or unsafe URLs", () => {
    const { container } = render(
      <MessageMarkdown
        authorKind="human"
        body={
          "**Decision**\n\n- keep the Room\n- ship `safely`\n\n[unsafe](javascript:alert(1))\n\n<script>window.evil = true</script>"
        }
      />,
    );

    expect(screen.getByText("Decision").tagName).toBe("STRONG");
    expect(screen.getByText("keep the Room").closest("li")).not.toBeNull();
    expect(screen.getByText("safely").tagName).toBe("CODE");
    expect(screen.getByText("unsafe").closest("a")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container).not.toHaveTextContent("window.evil");
  });

  it("renders Agent GFM tables and structured Mentions", () => {
    const onOpenActor = vi.fn();
    const { container } = render(
      <MessageMarkdown
        authorKind="agent"
        body={"@Codex\n\n| Item | State |\n| --- | --- |\n| V0 | Ready |"}
        mentions={[
          {
            display_name: "Codex",
            id: "actor-codex",
            kind: "agent",
            tenant_id: "tenant-northstar",
          },
        ]}
        onOpenActor={onOpenActor}
      />,
    );

    // An Agent mention shows its avatar and name, not "@Codex".
    const mention = screen.getByRole("button", { name: "@Codex" });
    expect(mention).toHaveClass("agent-mention");
    expect(mention.querySelector('[role="img"]')).not.toBeNull();
    expect(mention).not.toHaveTextContent("@");
    fireEvent.click(mention);
    expect(onOpenActor).toHaveBeenCalledWith("actor-codex");
    expect(screen.getByRole("table")).toBeVisible();
    expect(
      container.querySelector(".tiptap-table-scroll-viewport"),
    ).not.toBeNull();
    expect(screen.getByRole("cell", { name: "Ready" })).toBeVisible();
    expect(container.querySelector('a[href^="linger-actor:"]')).toBeNull();
  });

  it("normalizes a streamed Agent heading that omitted the marker space", () => {
    render(
      <MessageMarkdown authorKind="agent" body={"##6. Launch plan\n\nReady"} />,
    );

    expect(
      screen.getByRole("heading", { name: "6. Launch plan" }).tagName,
    ).toBe("H2");
  });

  it.each(["#1 top priority", "#tag not a heading"])(
    "keeps a single # before text as prose: %s",
    (body) => {
      render(<MessageMarkdown authorKind="agent" body={body} />);
      expect(screen.queryByRole("heading")).toBeNull();
      expect(screen.getByText(body).tagName).toBe("P");
    },
  );

  it.each([
    ["**けつろん：**なおった", "けつろん："],
    ["**100%**かんりょう", "100%"],
    ["1. **はいけい：**ユーザーのこえ", "はいけい："],
    ['けつろんは**"OK"**。', '"OK"'],
    ["**Done** in English", "Done"],
  ])(
    "renders CJK-adjacent emphasis for Agent and Human messages: %s",
    (body, strong) => {
      for (const authorKind of ["agent", "human"] as const) {
        const { container, unmount } = render(
          <MessageMarkdown authorKind={authorKind} body={body} />,
        );
        expect(container.querySelector("strong")?.textContent).toBe(strong);
        expect(container).not.toHaveTextContent("**");
        unmount();
      }
    },
  );

  it("keeps Agent single line breaks while tables still render", () => {
    const { container } = render(
      <MessageMarkdown
        authorKind="agent"
        body={"First line\nSecond line\n\n| A | B |\n| - | - |\n| 1 | 2 |"}
      />,
    );
    expect(container.querySelector("p")?.querySelectorAll("br")).toHaveLength(
      1,
    );
    expect(screen.getByRole("cell", { name: "2" })).toBeVisible();
  });

  it("separates adjacent mention references whose whitespace the sender dropped", () => {
    const segments: TeamHubMessageSegment[] = [
      { type: "text", content: "See " },
      {
        type: "reference",
        content: "Alice",
        target: "actor-alice",
        target_type: "user",
      },
      {
        type: "reference",
        content: "Bob",
        target: "actor-bob",
        target_type: "agent",
      },
    ];
    const { container } = render(
      <MessageMarkdown
        authorKind="agent"
        body={segments.map((segment) => segment.content).join("")}
        segments={segments}
        onOpenActor={vi.fn()}
      />,
    );
    expect(container.querySelector("p")?.textContent).toBe("See @Alice @Bob");
  });

  it("renders a structured Document mention with its authorized display title", () => {
    const onOpenDocument = vi.fn();
    const document = {
      content: "@Launch_plan_md",
      document_id: "document-plan",
      type: "document" as const,
    };
    render(
      <MessageMarkdown
        authorKind="human"
        body="Review @Launch_plan_md"
        documentReferences={[document]}
        documentTitles={{ "document-plan": "Launch plan.md" }}
        onOpenDocument={onOpenDocument}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Launch plan.md" }),
    );
    expect(onOpenDocument).toHaveBeenCalledWith(document);
  });

  it("keeps Agent local files as text while preserving external links", () => {
    render(
      <MessageMarkdown
        authorKind="agent"
        body={
          "[Open local HTML](./playground/review.html) and [read the source](https://example.com/review)"
        }
      />,
    );

    expect(screen.getByText("Open local HTML").closest("a")).toBeNull();
    expect(
      screen.getByRole("link", { name: "read the source" }),
    ).toHaveAttribute("href", "https://example.com/review");
  });

  it("opens an http link in the sidebar unless a modifier keeps the new tab", () => {
    const onOpenUrl = vi.fn();
    render(
      <MessageMarkdown
        authorKind="agent"
        body="[Docs](https://example.com/docs)"
        onOpenUrl={onOpenUrl}
      />,
    );
    const link = screen.getByRole("link", { name: "Docs" });
    fireEvent.click(link);
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/docs");
    onOpenUrl.mockClear();
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(onOpenUrl).not.toHaveBeenCalled();
  });
});
