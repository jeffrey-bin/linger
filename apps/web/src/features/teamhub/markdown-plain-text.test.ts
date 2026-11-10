import { describe, expect, it } from "vitest";

import { markdownPlainText } from "./markdown-plain-text";

describe("markdownPlainText", () => {
  it.each([
    [
      "## Conclusion\n\n**Fixed**, see [MR](https://example.com/1).",
      "Conclusion\n\nFixed, see MR.",
    ],
    [
      "> Quote *emphasis* and ~~deleted~~ and __bold__",
      "Quote emphasis and deleted and bold",
    ],
    ["- [x] Done\n- Todo\n1. Step one", "Done\nTodo\n1. Step one"],
    ["##6. Launch plan", "6. Launch plan"],
    ["Above\n\n---\n\nBelow", "Above\n\nBelow"],
    [
      "![Screenshot](a.png) <https://example.com>",
      "Screenshot https://example.com",
    ],
  ])("drops Markdown syntax from %j", (markdown, plain) => {
    expect(markdownPlainText(markdown)).toBe(plain);
  });

  it("flattens tables into cells without pipes or delimiter rows", () => {
    expect(
      markdownPlainText(
        "| Item | Status |\n| --- | :-: |\n| **A** | Done |\n\nEnd",
      ),
    ).toBe("Item · Status\nA · Done\n\nEnd");
  });

  it("keeps code, escapes, identifiers and issue numbers literal", () => {
    expect(
      markdownPlainText("Run `**a**` and \\*stars\\* snake_case_name 2*3"),
    ).toBe("Run **a** and *stars* snake_case_name 2*3");
    expect(markdownPlainText("#1 top priority\n#tag")).toBe(
      "#1 top priority\n#tag",
    );
    expect(markdownPlainText("```ts\nconst a = **b**;\n```")).toBe(
      "const a = **b**;",
    );
  });
});
