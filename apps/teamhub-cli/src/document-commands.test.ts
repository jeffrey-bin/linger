import { describe, expect, it, vi } from "vitest";
import { documentCommandDefinitions } from "./document-commands.js";
import { parseArguments } from "./command-input.js";
import type { CommandInputReader } from "./command-definition.js";
const reader: CommandInputReader = {
  cwd: "/work",
  text: vi.fn(async () => "  Body é\n"),
  json: vi.fn(async () => ({ thread_id: "thread_one" })),
};
const command = (...parts: string[]) =>
  documentCommandDefinitions.find(
    (def) => def.command.join(" ") === parts.join(" "),
  )!;
const normalize = (parts: string[], args: string[]) => {
  const def = command(...parts);
  return def.normalize(parseArguments(args, def.options), reader);
};
describe("Document command boundary", () => {
  it("exposes eight commands without old aliases", () => {
    expect(documentCommandDefinitions).toHaveLength(8);
    expect(
      documentCommandDefinitions.map((def) => def.command.join(" ")),
    ).toContain("docs update");
    expect(
      documentCommandDefinitions.map((def) => def.command.join(" ")),
    ).not.toContain("docs mutate");
    expect(
      documentCommandDefinitions.map((def) => def.command.join(" ")),
    ).not.toContain("docs request");
  });
  it("makes inline and file bodies equivalent and retains whitespace and empty bodies", async () => {
    const inline = await normalize(
      ["docs", "create"],
      ["--title", "Title", "--content", "  Body é\n"],
    );
    expect(inline).toEqual(
      await normalize(
        ["docs", "create"],
        ["--title", "Title", "--file", "draft.md"],
      ),
    );
    // The Room or Task comes from the configured caller Context, never a flag.
    expect(inline).toEqual({
      input: { title: "Title", markdown: "  Body é\n" },
    });
    expect(command("docs", "create").options).not.toHaveProperty("--task");
    expect(command("docs", "create").options).not.toHaveProperty("--room");
    expect(
      (
        await normalize(
          ["docs", "create"],
          ["--title", "Empty", "--content", ""],
        )
      ).input.markdown,
    ).toBe("");
  });
  it("decodes inline \\n into Markdown lines and keeps file bodies literal", async () => {
    expect(
      (
        await normalize(
          ["docs", "create"],
          ["--title", "Title", "--content", "# Title\\n\\nBody é `a\\nb`"],
        )
      ).input.markdown,
    ).toBe("# Title\n\nBody é `a\\nb`");
    vi.mocked(reader.text).mockResolvedValueOnce("Literal é \\n");
    expect(
      (await normalize(["docs", "create"], ["--title", "Title", "--file", "x"]))
        .input.markdown,
    ).toBe("Literal é \\n");
  });
  it("rejects source/action conflicts before reading files", async () => {
    vi.mocked(reader.text).mockClear();
    await expect(
      normalize(
        ["docs", "create"],
        ["--title", "Title", "--content", "x", "--file", "x"],
      ),
    ).rejects.toThrow();
    await expect(
      normalize(
        ["docs", "update"],
        [
          "document_one",
          "--command",
          "set_title",
          "--title",
          "New",
          "--file",
          "x",
        ],
      ),
    ).rejects.toThrow();
    expect(reader.text).not.toHaveBeenCalled();
    await expect(
      normalize(
        ["docs", "update"],
        [
          "document_one",
          "--command",
          "block_delete",
          "--start-block-id",
          "first",
        ],
      ),
    ).rejects.toThrow();
  });
  it("normalizes one local edit against only the explicit Document", async () => {
    expect(
      await normalize(
        ["docs", "update"],
        [
          "document_one",
          "--command",
          "str_replace",
          "--pattern",
          "Draft",
          "--content",
          "",
        ],
      ),
    ).toMatchObject({
      input: {
        document_id: "document_one",
        command: "str_replace",
        pattern: "Draft",
        content: "",
      },
      target: { type: "document", id: "document_one" },
      scope: { kind: "document", id: "document_one" },
    });
  });
  it("maps duplicates only from validated replay flags and retains conflicts", () => {
    const def = command("docs", "update");
    expect(
      def.project!({
        status: "conflicted",
        semantic_mutation_id: "mutation_one",
        conflict_reason: "stale_head",
        replayed: true,
      }),
    ).toMatchObject({
      status: "conflicted",
      conflict_reason: "stale_head",
      duplicate_request: true,
      reason: expect.stringContaining("conflict"),
    });
    expect(def.project!({ status: "applied", replayed: false })).toEqual({
      status: "applied",
      duplicate_request: false,
    });
    expect(() => def.project!({ status: "applied" })).toThrow();
  });
  it("uses thread authority for comments", async () => {
    expect(
      await normalize(["docs", "comment", "get"], ["thread_one"]),
    ).toMatchObject({
      target: { type: "thread", id: "thread_one" },
      scope: { kind: "thread", id: "thread_one" },
    });
    expect(
      (
        await normalize(
          ["docs", "comment", "reply"],
          ["thread_one", "--content", "Hello [@Alice](user:actor_alice)"],
        )
      ).input,
    ).toMatchObject({
      segments: [
        { type: "text", content: "Hello " },
        { type: "reference", actor_id: "actor_alice", content: "Alice" },
      ],
    });
  });
  it("does not synthesize mutation outcomes or omit comment observations", () => {
    const def = command("docs", "comment", "replace");
    expect(
      def.render!({
        thread_id: "thread_one",
        status: "conflicted",
        conflict_reason: "missing_comment_selection",
        observation: "Selection changed",
        duplicate_request: false,
      }),
    ).toContain("Observation: Selection changed");
  });
});
