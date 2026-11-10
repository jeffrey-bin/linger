import { describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { commandDefinitions } from "./domain-commands.js";

// CJK scripts plus CJK symbols/punctuation and half/full-width forms.
const NON_ENGLISH_TEXT =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\u3000-\u303F\uFF00-\uFFEF]/u;

async function invoke(
  args: string[],
  response?: unknown,
  env: NodeJS.ProcessEnv = {
    TEAMHUB_URL: "https://teamhub.example",
    TEAMHUB_TOKEN: "th_agent_example",
  },
) {
  const output: string[] = [];
  const errors: string[] = [];
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(response ?? {}), { status: 200 }),
  );
  const readInput = vi.fn(async () => {
    throw new Error("must not read");
  });
  const code = await runCli(args, {
    cwd: "/tmp",
    env,
    fetch: fetch,
    readInput,
    stdout: (text) => {
      output.push(text);
    },
    stderr: (text) => {
      errors.push(text);
    },
  });
  return {
    code,
    output: output.join(""),
    error: errors.join(""),
    fetch,
    readInput,
  };
}
describe("redesigned CLI surface", () => {
  it("lists only the ten public root entries offline", async () => {
    const result = await invoke(["--help"]);
    expect(result.code).toBe(0);
    for (const name of [
      "agent",
      "apps",
      "docs",
      "knowledge",
      "message",
      "room",
      "task",
      "routine",
      "profile",
      "help",
    ])
      expect(result.output).toMatch(new RegExp(`^  ${name}$`, "m"));
    expect(result.output).not.toMatch(
      /teamhub (commands|human|build|publish|skill|update)/,
    );
    expect(result.output).not.toMatch(/^ {2}agents$/m);
    expect(result.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["apps", "search"],
    ["knowledge", "search"],
    ["knowledge", "read"],
    ["profile", "skill", "publish"],
    ["routine", "run"],
  ])(
    "shows required positional arguments in offline %s %s %s help",
    async (...command) => {
      const result = await invoke([...command, "--help"], undefined, {});
      expect(result.code).toBe(0);
      const positional =
        command[0] === "apps"
          ? "<query>"
          : command[0] === "knowledge"
            ? command[1] === "search"
              ? "<query>"
              : "<evidence-id>"
            : command[0] === "profile"
              ? "<folder>"
              : "<routine-id>";
      expect(result.output).toContain(`Arguments:\n  ${positional}`);
      expect(result.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { sections: ["summary"], offset: undefined },
    { sections: ["summary", "decisions"], offset: undefined },
    { sections: ["summary"], offset: 12000 },
  ])(
    "reads evidence with sections $sections and offset $offset",
    async ({ sections, offset }) => {
      const evidenceId = "raw_0123456789abcdef_0123456789abcdef";
      const content = "verified / vérifié ✓";
      const response = {
        schemaVersion: 1,
        evidenceId,
        title: "Report",
        source: { kind: "wiki", ref: "report" },
        complete: true,
        directory: [],
        missingSections: [],
        sections: sections.map((id) => ({
          id,
          title: id,
          level: 1,
          content,
          offset: offset ?? 0,
          truncated: false,
        })),
      };
      const result = await invoke(
        [
          "knowledge",
          "read",
          evidenceId,
          ...sections.flatMap((id) => ["--section-id", id]),
          ...(offset === undefined ? [] : ["--offset", String(offset)]),
          "--json",
        ],
        response,
      );
      expect(result.code).toBe(0);
      expect(result.error).toBe("");
      expect(result.fetch).toHaveBeenCalledExactlyOnceWith(
        "https://teamhub.example/api/agent/v1/knowledge/read",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            evidenceId,
            sectionRequests: sections.map((sectionId) => ({
              sectionId,
              ...(offset === undefined ? {} : { offset }),
            })),
          }),
        }),
      );
      expect(result.output).toContain(content);
      expect(JSON.parse(result.output).schemaVersion).toBe(2);
    },
  );

  it.each([
    ["raw_0123456789abcdef_0123456789abcdef"],
    ["--evidence-id", "raw_0123456789abcdef_0123456789abcdef"],
    [
      "raw_0123456789abcdef_0123456789abcdef",
      "--section-id",
      "summary",
      "--limit",
      "500",
    ],
    ["--section-id", "summary"],
    [
      "raw_0123456789abcdef_0123456789abcdef",
      "--section-id",
      "summary",
      "--section-id",
      "decisions",
      "--offset",
      "0",
    ],
  ])("rejects incompatible read syntax before HTTP: %j", async (...input) => {
    const result = await invoke(["knowledge", "read", ...input, "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.error).error.code).toBe("usage");
    expect(result.fetch).not.toHaveBeenCalled();
  });

  it("keeps root and group help free of Chinese and full-width punctuation", async () => {
    const groups = new Set<string>();
    for (const { command } of commandDefinitions)
      for (let length = 1; length < command.length; length += 1)
        groups.add(command.slice(0, length).join(" "));
    const invocations = [
      [],
      ["--help"],
      ...[...groups].map((group) => [...group.split(" "), "--help"]),
    ];
    for (const args of invocations) {
      const result = await invoke(args, undefined, {});
      expect(result.output, args.join(" ")).not.toMatch(NON_ENGLISH_TEXT);
      expect(result.error, args.join(" ")).not.toMatch(NON_ENGLISH_TEXT);
      expect(result.fetch).not.toHaveBeenCalled();
    }
  });
  it("serves every public command help and supported schema offline", async () => {
    for (const definition of commandDefinitions) {
      const help = await invoke(
        [...definition.command, "--help"],
        undefined,
        {},
      );
      expect(help.code, definition.command.join(" ")).toBe(0);
      expect(help.output).toContain(`teamhub ${definition.command.join(" ")}`);
      expect(help.output, definition.command.join(" ")).not.toMatch(
        NON_ENGLISH_TEXT,
      );
      expect(help.fetch).not.toHaveBeenCalled();
      expect(help.readInput).not.toHaveBeenCalled();
      if (
        definition.schema === false ||
        (definition.fileRoute && definition.schema !== true)
      )
        continue;
      const schema = await invoke(
        [...definition.command, "--schema"],
        undefined,
        {},
      );
      expect(schema.code, definition.command.join(" ")).toBe(0);
      expect(JSON.parse(schema.output).command).toEqual(definition.command);
      expect(schema.output, definition.command.join(" ")).not.toMatch(
        NON_ENGLISH_TEXT,
      );
      expect(schema.fetch).not.toHaveBeenCalled();
      expect(schema.readInput).not.toHaveBeenCalled();
    }
  });
  it("never serves an empty input or output schema", async () => {
    const shell = JSON.stringify({ type: "object" });
    for (const definition of commandDefinitions) {
      if (
        definition.schema === false ||
        (definition.fileRoute && definition.schema !== true)
      )
        continue;
      const schema = await invoke(
        [...definition.command, "--schema", "--json"],
        undefined,
        {},
      );
      expect(schema.code, definition.command.join(" ")).toBe(0);
      const value = JSON.parse(schema.output) as Record<string, unknown>;
      for (const key of ["input_schema", "output_schema"])
        expect(
          JSON.stringify(value[key]),
          `${definition.command.join(" ")} ${key}`,
        ).not.toBe(shell);
    }
  });
  it("returns schema before required arguments, files or configuration", async () => {
    const result = await invoke(["message", "send", "--schema", "--json"]);
    expect(result.code).toBe(0);
    expect(result.readInput).not.toHaveBeenCalled();
    expect(result.fetch).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toHaveProperty("cli.options.--content");
  });
  it.each(["human", "build", "commands", "publish", "update", "skill"])(
    "rejects retired %s root before configuration",
    async (root) => {
      const result = await invoke([root, "--json"]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.error).error.code).toBe("usage");
      expect(result.fetch).not.toHaveBeenCalled();
    },
  );
  it("preserves target context for an invalid business input without claiming existence", async () => {
    const result = await invoke([
      "message",
      "send",
      "--thread",
      "thread_example",
      "--message",
      '{"unexpected":true}',
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.error).error).toMatchObject({
      command: "message send",
      target: { type: "thread", id: "thread_example" },
    });
  });
});
