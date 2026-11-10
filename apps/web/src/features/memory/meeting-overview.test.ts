import { describe, expect, it } from "vitest";
import { parseMeetingSummary } from "./meeting-overview";

const sessionMarkdown = `---
{
  "type": "Session",
  "title": "オープンソース personal agent プロジェクトけいかくかいぎ",
  "session_id": "capture_session_planning",
  "date": "2026-10-20",
  "sources": [{ "id": "R1", "resource": "teamhub://documents/t/versions/v1" }]
}
---

# オープンソース personal agent プロジェクトけいかくかいぎ

## Objective Summary

かいぎでオープンソースばんは**ローカルファーストのデータプライバシー**をコアのさべつかとした [R1]。だいいちだんかいはコアきのうにしゅうちゅうし，ふようなきのうをけずる。おんせいきのうのスケジュールはみてい。

## Keywords

- personal agent
- ローカルファースト [R1]
- [Northstar](../../clients/northstar.md)

## Meeting Summary

### プロダクトのいちづけ [00:00:10 - 00:05:00]

オープンソースばんはローカルファーストをちゅうしんにする。[R1]

- オープンソースのコアさべつかは**ローカルファースト** [R1]。
  - Evidence: Speaker 1, 00:01:00 [R1]
- にばんめものこす。
  - しょうさいのほそく。
- さんばんめ
- よんばんめ
- ごばんめ，じょうげんなし。
- Evidence: Speaker 2 [R1]

### リリースのリズム

10 がつまつにオープンソースかんりょう。
11 がつに PC ばん APP をリリース。

### みてい

None observed.

## Main Topics

### ターゲットユーザー [00:01:10 - 00:08:42]

- **そうぎょうしゃ**、えいぎょうとちいきサービスぎょうしゃをカバー [R1]。
  - Evidence: Speaker 1, 00:02:10 [R1]
- だいひょうてきなじれいに KOL グループがある。
- さんばんめはひょうじされない。

### リリースのリズム (00:09:00 - 00:15:30)

#### だんかいわけ

10 がつまつにオープンソースかんりょう，local first のコアとくちょうをうちだす [R1]。11 がつに PC ばん APP をリリース。

### みていのもんだい

None observed.

## Decisions And Outcomes

- Decision: だいいちばんはウェブばんをゆうせん [R1]
  - Evidence: Speaker 2, 00:12:00 [R1]
- Completed: ぎじゅつせんていのひょうかをかんりょう [[source:raw:S1]]
- Decision: ローカルデプロイに llama.cpp をさいよう
- Decision: きぞんのクラウドサンドボックスをさいりよう
- Decision: おうとうちえんは 1 びょうみまん

## Action Items

- Action: Gemma りょうしかテストのけっかをまとめる [R1]
  - Owner: Zhang San
  - Deadline: らいしゅうのきんようび
  - Evidence: Speaker 1, 00:20:00 [R1]
- Action: ウェブばんのデザインあんをよういする

## Pattern

None observed.
`;

describe("parseMeetingSummary", () => {
  it("splits a non-English Session page into the reader's blocks, dropping empty sections", () => {
    const blocks = parseMeetingSummary(sessionMarkdown);
    expect(blocks.map((block) => block.kind)).toEqual([
      "markdown",
      "keywords",
      "topics",
      "markdown",
      "outcomes",
      "outcomes",
      "markdown",
    ]);
    const [lead, keywords, topics, mainTopics, decisions, actions, pattern] =
      blocks;
    // Frontmatter stays with the first run for the knowledge presentation.
    expect(lead?.kind === "markdown" && lead.markdown).toMatch(/^---\n\{/u);
    expect(keywords).toEqual({
      kind: "keywords",
      title: "Keywords",
      keywords: ["personal agent", "ローカルファースト", "Northstar"],
    });
    expect(topics?.kind === "topics" && topics.topics).toEqual([
      {
        title: "プロダクトのいちづけ",
        time: "00:00:10 – 00:05:00",
        intro: "オープンソースばんはローカルファーストをちゅうしんにする。",
        points: [
          {
            text: "オープンソースのコアさべつかは**ローカルファースト**。",
            children: [],
          },
          {
            text: "にばんめものこす。",
            children: ["しょうさいのほそく。"],
          },
          { text: "さんばんめ", children: [] },
          { text: "よんばんめ", children: [] },
          {
            text: "ごばんめ，じょうげんなし。",
            children: [],
          },
        ],
      },
      {
        title: "リリースのリズム",
        time: null,
        intro:
          "10 がつまつにオープンソースかんりょう。 11 がつに PC ばん APP をリリース。",
        points: [],
      },
    ]);
    expect(mainTopics?.kind === "markdown" && mainTopics.markdown).toMatch(
      /^## Main Topics/u,
    );
    expect(decisions).toMatchObject({
      kind: "outcomes",
      title: "Decisions And Outcomes",
      outcomes: [
        {
          label: "Decision",
          text: "だいいちばんはウェブばんをゆうせん",
          children: [],
        },
        {
          label: "Completed",
          text: "ぎじゅつせんていのひょうかをかんりょう",
          children: [],
        },
        {
          label: "Decision",
          text: "ローカルデプロイに llama.cpp をさいよう",
        },
        {
          label: "Decision",
          text: "きぞんのクラウドサンドボックスをさいりよう",
        },
        {
          label: "Decision",
          text: "おうとうちえんは 1 びょうみまん",
        },
      ],
    });
    expect(actions).toMatchObject({
      title: "To-do list",
      outcomes: [
        {
          label: "Action",
          text: "Gemma りょうしかテストのけっかをまとめる",
          children: ["Owner: Zhang San", "Deadline: らいしゅうのきんようび"],
        },
        {
          label: "Action",
          text: "ウェブばんのデザインあんをよういする",
          children: [],
        },
      ],
    });
    // Pattern always shows, even when it only says None observed.
    expect(pattern).toEqual({
      kind: "markdown",
      markdown: "## Pattern\n\nNone observed.",
    });
  });

  it("hides None observed sections, keeping an empty to-do list and Pattern", () => {
    const blocks = parseMeetingSummary(
      [
        "## Objective Summary",
        "",
        "None observed.",
        "",
        "## Keywords",
        "",
        "None observed.",
        "",
        "## Decisions And Outcomes",
        "",
        "- Completed: Shipped 12.1. [R1]",
        "  - Evidence: [R1]",
        "",
        "## Action Items",
        "",
        "None observed.",
        "",
        "## Pattern",
        "",
        "None observed. [R1]",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      {
        kind: "outcomes",
        title: "Decisions And Outcomes",
        outcomes: [{ label: "Completed", text: "Shipped 12.1.", children: [] }],
      },
      { kind: "outcomes", title: "To-do list", outcomes: [] },
      { kind: "markdown", markdown: "## Pattern\n\nNone observed." },
    ]);
  });

  it("reads only the exact rendered labels and section titles", () => {
    const blocks = parseMeetingSummary(
      [
        "## Decisions And Outcomes",
        "",
        "- **Decision:** Ship the beta.",
        "- decision: Lowercase label.",
        "- Decision: Ship the web app.",
        "",
        "## decisions and outcomes",
        "",
        "- Decision: Not the generated section.",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      {
        kind: "outcomes",
        title: "Decisions And Outcomes",
        outcomes: [
          { label: null, text: "**Decision:** Ship the beta.", children: [] },
          { label: null, text: "decision: Lowercase label.", children: [] },
          { label: "Decision", text: "Ship the web app.", children: [] },
        ],
      },
      {
        kind: "markdown",
        markdown:
          "## decisions and outcomes\n\n- Decision: Not the generated section.",
      },
    ]);
  });

  it("keeps a page without these sections as one Markdown run", () => {
    expect(parseMeetingSummary("# Notes\n\nJust a paragraph.")).toEqual([
      { kind: "markdown", markdown: "# Notes\n\nJust a paragraph." },
    ]);
    expect(parseMeetingSummary("")).toEqual([]);
    // Meeting Summary without topics stays in the document.
    expect(
      parseMeetingSummary("## Meeting Summary\n\nNo topics here."),
    ).toEqual([
      { kind: "markdown", markdown: "## Meeting Summary\n\nNo topics here." },
    ]);
  });
});
