import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bodySource,
  createInputReader,
  jsonSource,
  markdownBodySource,
  parseArguments,
  parseJsonValue,
  targetFromFlags,
} from "./command-input.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const flags = {
  "--content": { description: "Body", repeatable: true },
  "--file": { description: "File", repeatable: true },
  "--output": { description: "JSON" },
  "--output-file": { description: "JSON file" },
  "--thread": { description: "Thread" },
  "--alterego": { description: "Task" },
  "--json": { description: "JSON output", boolean: true },
};

describe("CLI input sources", () => {
  it("preserves literal option values and the order of repeatable bodies", () => {
    const parsed = parseArguments(
      [
        "--content",
        "--help",
        "--file",
        "./a.md",
        "--content",
        "Café déjà vu\n",
        "--json",
      ],
      flags,
    );
    expect(parsed.options["--content"]).toEqual(["--help", "Café déjà vu\n"]);
    expect(parsed.ordered.map(({ name, value }) => [name, value])).toEqual([
      ["--content", "--help"],
      ["--file", "./a.md"],
      ["--content", "Café déjà vu\n"],
      ["--json", "true"],
    ]);
  });
  it.each([
    ["--scope", "room:room_one"],
    ["--output", "{}", "--output", "{}"],
    ["--json", "--json"],
    ["--file"],
  ])("rejects unknown, duplicate and missing options: %j", (...args) => {
    expect(() => parseArguments(args, flags)).toThrow();
  });
  it("rejects two stdin sources before reading either", () => {
    expect(() =>
      parseArguments(["--file", "-", "--output-file", "-"], flags),
    ).toThrow(/stdin/i);
  });
  it("keeps direct content literal, including empty content", async () => {
    const readInput = vi.fn(async () => "unexpected");
    const reader = createInputReader({ cwd: "/work", readInput });
    for (const value of ["", "-", "@file", "./body.md", "  Café déjà vu\n"]) {
      expect(
        await bodySource(parseArguments(["--content", value], flags), reader),
      ).toBe(value);
    }
    expect(readInput).not.toHaveBeenCalled();
  });
  it("decodes Markdown inline bodies outside code only", async () => {
    const reader = createInputReader({
      cwd: "/work",
      readInput: async () => "file \\n",
    });
    expect(
      await markdownBodySource(
        parseArguments(["--content", "a\\nb\n```\nx\\ny\n```\n\\\\n"], flags),
        reader,
      ),
    ).toBe("a\nb\n```\nx\\ny\n```\n\\n");
    expect(
      await markdownBodySource(parseArguments(["--file", "x"], flags), reader),
    ).toBe("file \\n");
  });
  it("rejects conflicting body sources before reading", async () => {
    const readInput = vi.fn(async () => "body");
    await expect(
      bodySource(
        parseArguments(["--content", "hello", "--file", "-"], flags),
        createInputReader({ cwd: "/work", readInput }),
      ),
    ).rejects.toThrow();
    expect(readInput).not.toHaveBeenCalled();
  });
  it("maps raw files and JSON files without conflating their types", async () => {
    const readInput = vi.fn(async () => '"hello"\n');
    const reader = createInputReader({ cwd: "/work", readInput });
    expect(
      await bodySource(parseArguments(["--file", "./body.txt"], flags), reader),
    ).toBe('"hello"\n');
    expect(
      await jsonSource(
        parseArguments(["--output-file", "./result.json"], flags),
        reader,
        "--output",
        "--output-file",
      ),
    ).toBe("hello");
    expect(readInput).toHaveBeenNthCalledWith(
      1,
      path.resolve("/work/body.txt"),
    );
  });
  it.each([-1, 0, 1])(
    "enforces the 5 MiB UTF-8 file boundary at offset %i",
    async (offset) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "teamhub-input-limit-"),
      );
      directories.push(directory);
      const bytes = Buffer.alloc(5 * 1024 * 1024 + offset, "a");
      await writeFile(path.join(directory, "body"), bytes);
      const read = createInputReader({ cwd: directory }).text("body");
      if (offset > 0)
        await expect(read).rejects.toMatchObject({ code: "invalid_input" });
      else expect(Buffer.byteLength(await read)).toBe(bytes.length);
    },
  );
  it("rejects malformed UTF-8 instead of silently replacing bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "teamhub-input-"));
    directories.push(directory);
    await writeFile(path.join(directory, "body"), Buffer.from([0xc3, 0x28]));
    await expect(
      createInputReader({ cwd: directory }).text("body"),
    ).rejects.toThrow(/UTF-8/);
  });
  it("reads stdin only once even when called by multiple field readers", async () => {
    const readInput = vi.fn(async () => "body");
    const reader = createInputReader({ cwd: "/work", readInput });
    expect(await reader.text("-")).toBe("body");
    await expect(reader.text("-")).rejects.toThrow(/stdin/i);
    expect(readInput).toHaveBeenCalledTimes(1);
  });
  it.each([
    '{"key":1,"key":2}',
    '{"nested":{"a":1,"\\u0061":2}}',
    '[{"a":1,"a":2}]',
  ])("rejects duplicate JSON keys: %s", (text) => {
    expect(() => parseJsonValue(text)).toThrow(/duplicate/i);
  });
  it("allows same property names in different objects and preserves JSON types", () => {
    expect(
      parseJsonValue('{"one":{"a":1},"two":{"a":2},"items":[null,true,"a:b"]}'),
    ).toEqual({ one: { a: 1 }, two: { a: 2 }, items: [null, true, "a:b"] });
  });
  it("keeps targets bare, never derives a caller Context and rejects ambiguous target flags", () => {
    const selected = targetFromFlags(
      parseArguments(["--thread", "thread_one"], flags),
      ["thread", "alterego"],
    );
    expect(selected).toEqual({ target: { type: "thread", id: "thread_one" } });
    expect(selected).not.toHaveProperty("scope");
    expect(
      targetFromFlags(parseArguments([], flags), ["thread", "alterego"]),
    ).toEqual({});
    expect(() =>
      targetFromFlags(
        parseArguments(
          ["--thread", "thread_one", "--alterego", "task_one"],
          flags,
        ),
        ["thread", "alterego"],
      ),
    ).toThrow();
    expect(() =>
      targetFromFlags(parseArguments(["--alterego", "task:task_one"], flags), [
        "alterego",
      ]),
    ).toThrow();
  });
});
