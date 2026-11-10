import { describe, expect, it } from "vitest";
import type {
  CommandArguments,
  CommandInputReader,
} from "./command-definition.js";
import { messageCommandDefinitions } from "./message-commands.js";

function args(
  entries: readonly [string, string][] = [],
  positionals: string[] = [],
): CommandArguments {
  const options: Record<string, string[]> = {};
  for (const [name, value] of entries) (options[name] ??= []).push(value);
  return {
    positionals,
    options,
    ordered: entries.map(([name, value]) => ({ name, value })),
  };
}
const reader: CommandInputReader = {
  cwd: "/work",
  text: async (source) => (source === "body.md" ? "Hello\n\nworld" : source),
  json: async (source) => JSON.parse(source),
};
const command = (name: string) =>
  messageCommandDefinitions.find((item) => item.command[1] === name)!;

describe("redesigned message inputs", () => {
  it("normalizes ordinary send into the same segments as complete input", async () => {
    const plain = await command("send").normalize(
      args([["--content", "Hello"]]),
      reader,
    );
    const complete = await command("send").normalize(
      args([["--message", '{"segments":[{"type":"text","content":"Hello"}]}']]),
      reader,
    );
    expect(plain).toEqual(complete);
  });
  it("requires a fragment to carry one short title line", async () => {
    const send = (segment: object) =>
      command("send").normalize(
        args([["--message", JSON.stringify({ segments: [segment] })]]),
        reader,
      );
    await expect(
      send({
        type: "fragment",
        title: "Launch tracker",
        content: "<p>3/5</p>",
      }),
    ).resolves.toBeDefined();
    for (const title of [
      undefined,
      "",
      " padded",
      "two\nlines",
      "x".repeat(121),
    ])
      await expect(
        send({ type: "fragment", title, content: "<p>3/5</p>" }),
      ).rejects.toThrow();
  });
  it("declares continuation for the configured Context and a Thread", async () => {
    const plain = await command("send").normalize(
      args([["--content", "On it"]]),
      reader,
    );
    expect(plain.input).not.toHaveProperty("continues");
    // The configured Room or Task, or a Thread inside the configured Room.
    for (const target of [[], [["--thread", "thread_example"]]] as [
      string,
      string,
    ][][]) {
      const continuing = await command("send").normalize(
        args([...target, ["--content", "On it"], ["--continuing", "true"]]),
        reader,
      );
      expect(continuing.input).toMatchObject({ continues: true });
    }
  });
  it.each(["send", "direct", "sequence"])(
    "decodes shell-escaped line breaks in %s inline bodies",
    async (name) => {
      const entries: [string, string][] =
        name === "sequence"
          ? [
              ["--pause", "brief"],
              ["--content", "Second bubble"],
            ]
          : [];
      const result = await command(name).normalize(
        args([
          [
            "--content",
            "Confirmation is needed before canceling.\\n\\nI can keep checking the bill.",
          ],
          ...entries,
        ]),
        reader,
      );
      expect(JSON.stringify(result.input)).toContain(
        JSON.stringify(
          "Confirmation is needed before canceling.\n\nI can keep checking the bill.",
        ),
      );
    },
  );
  it("keeps code literal and decodes only \\n, \\t and \\\\ in inline bodies", async () => {
    const result = await command("send").normalize(
      args([
        [
          "--content",
          "first line\\nsecond line\\tcolumn code `a\\nb` keeps literal \\\\n and C:\\\\new \\*asterisk\\*",
        ],
      ]),
      reader,
    );
    expect(result.input.message_segments).toEqual([
      {
        type: "text",
        content:
          "first line\nsecond line\tcolumn code `a\\nb` keeps literal \\n and C:\\new \\*asterisk\\*",
      },
    ]);
  });
  it("preserves real line breaks and explicit literal escapes from stdin or JSON", async () => {
    const content = "First paragraph\n\nSecond paragraph";
    const inline = await command("send").normalize(
      args([["--content", content]]),
      reader,
    );
    expect(inline.input.message_segments).toEqual([{ type: "text", content }]);
    const literal = String.raw`A regex or Windows path: \n C:\new`;
    for (const entries of [
      [["--file", "-"]],
      [
        [
          "--message",
          JSON.stringify({ segments: [{ type: "text", content: literal }] }),
        ],
      ],
    ] as [string, string][][]) {
      const result = await command("send").normalize(args(entries), {
        ...reader,
        text: async () => literal,
      });
      expect(result.input.message_segments).toEqual([
        { type: "text", content: literal },
      ]);
    }
  });
  it("keeps mentions in code/escaped text literal while extracting real references", async () => {
    const content =
      "Hi [@Alice](user:actor_alice) `[@Code](agent:actor_code)` \\[@Escaped](agent:actor_escaped)\n```md\n[@Block](agent:actor_block)\n```";
    const result = await command("send").normalize(
      args([["--content", content]]),
      reader,
    );
    expect(
      (result.input.message_segments as Record<string, unknown>[]).filter(
        (segment) => segment.type === "reference",
      ),
    ).toEqual([
      {
        type: "reference",
        content: "Alice",
        target: "actor_alice",
        target_type: "user",
      },
    ]);
  });
  it("routes to the configured Context and offers no private Task targets", async () => {
    // The CLI fills the Inbox from the configured caller Context.
    expect(
      await command("send").normalize(args([["--content", "Update"]]), reader),
    ).toEqual({
      input: { message_segments: [{ type: "text", content: "Update" }] },
    });
    expect(command("send").options).not.toHaveProperty("--alterego");
    expect(command("send").options).not.toHaveProperty("--meta");
  });
  it("only accepts strict message envelopes, with images and videos sent as files", async () => {
    for (const message of [
      "[]",
      '{"segments":[{"type":"text","content":"x"}],"reply_to":"message_one"}',
      '{"segments":[{"type":"image","document_id":"doc_one"}]}',
      '{"segments":[{"type":"video","content-path":"clip.mp4"}]}',
    ]) {
      await expect(
        command("send").normalize(args([["--message", message]]), reader),
      ).rejects.toThrow();
    }
  });
  it("maps reply-to independently of the envelope and retains attachments in order", async () => {
    const result = await command("send").normalize(
      args([
        ["--reply-to", "message_one"],
        ["--content", "Text"],
        ["--attach", "a.pdf"],
        ["--attach", "b.md"],
      ]),
      reader,
    );
    expect(result.input).toEqual({
      source_message_id: "message_one",
      message_segments: [
        { type: "text", content: "Text" },
        { type: "document", "content-path": "a.pdf" },
        { type: "document", "content-path": "b.md" },
      ],
    });
  });
  it("preserves direct body occurrence order, newlines, and literal mention text", async () => {
    const result = await command("direct").normalize(
      args([
        ["--content", "[@Alice](user:actor_alice)"],
        ["--file", "body.md"],
        ["--content", "Third"],
      ]),
      reader,
    );
    expect(result.input).toEqual({
      messages: ["[@Alice](user:actor_alice)", "Hello\n\nworld", "Third"],
    });
    expect(
      await command("direct").normalize(
        args([["--messages", JSON.stringify(result.input.messages)]]),
        reader,
      ),
    ).toEqual(result);
  });
  it("sequence requires explicit rhythm and first none, with equivalent complete mode", async () => {
    const ordinary = await command("sequence").normalize(
      args([
        ["--content", "One"],
        ["--file", "Two"],
        ["--pause", "brief"],
      ]),
      reader,
    );
    expect(ordinary.input.messages).toEqual([
      { content: "One", pause_before: "none" },
      { content: "Two", pause_before: "brief" },
    ]);
    expect(
      await command("sequence").normalize(
        args([
          ["--message", JSON.stringify({ messages: ordinary.input.messages })],
        ]),
        reader,
      ),
    ).toEqual(ordinary);
    await expect(
      command("sequence").normalize(
        args([
          ["--content", "One"],
          ["--content", "Two"],
        ]),
        reader,
      ),
    ).rejects.toThrow();
    await expect(
      command("sequence").normalize(
        args([
          [
            "--message",
            '{"messages":[{"content":"One","pause_before":"brief"},{"content":"Two","pause_before":"brief"}]}',
          ],
        ]),
        reader,
      ),
    ).rejects.toThrow();
  });
  it("read batch trims IDs but rejects duplicates/empty lists/paging", async () => {
    expect(
      (
        await command("read").normalize(
          args([["--message-ids", "message_b, message_a"]]),
          reader,
        )
      ).input,
    ).toEqual({ message_ids: ["message_b", "message_a"] });
    for (const entries of [
      [["--message-ids", "a,a"]],
      [["--message-ids", "a,"]],
      [
        ["--message-ids", "a"],
        ["--limit", "1"],
      ],
      [["--inbox", "task:"]],
      [["--inbox", "room:"]],
      [["--inbox", "room/abc"]],
      [["--inbox", "bogus:x"]],
      [["--inbox", `room:${"a".repeat(512)}`]],
      [
        ["--inbox", "room:x"],
        ["--thread", "y"],
      ],
      [
        ["--inbox", "room:x"],
        ["--message-ids", "a"],
      ],
    ] as [string, string][][]) {
      await expect(
        command("read").normalize(args(entries), reader),
      ).rejects.toThrow();
    }
  });
  it.each([
    "task:task.alpha:7",
    "meta:actor_one:task_one",
    "taskmeta:task_one",
    "room:room_abc",
    "thread:thread_one",
  ])(
    "reads the explicit %s Inbox independently of the configured Context",
    async (inbox) => {
      expect(
        await command("read").normalize(
          args([
            ["--inbox", inbox],
            ["--limit", "5"],
          ]),
          reader,
        ),
      ).toEqual({
        input: { inbox_id: inbox, limit: 5 },
        target: { type: "inbox", id: inbox },
      });
    },
  );
  it("names every accepted --inbox address in the rejection", async () => {
    await expect(
      command("read").normalize(args([["--inbox", "bogus:room_one"]]), reader),
    ).rejects.toThrow(
      "--inbox accepts only room:, thread:, task:, meta: or taskmeta: addresses.",
    );
  });
  it("uses actual Thread ID and no default filtering for search/discovery", async () => {
    expect(
      await command("read").normalize(
        args([
          ["--thread", "thread_one"],
          ["--limit", "5"],
        ]),
        reader,
      ),
    ).toMatchObject({
      input: { thread_id: "thread_one", limit: 5 },
      target: { type: "thread", id: "thread_one" },
    });
    expect(
      (
        await command("read").normalize(
          args([["--list-inboxes", "true"]]),
          reader,
        )
      ).input,
    ).toEqual({ list_inboxes: true });
    expect(
      (
        await command("search").normalize(
          args([], [" exact %_ query "]),
          reader,
        )
      ).input,
    ).toEqual({ query: " exact %_ query " });
    expect(
      (
        await command("search").normalize(
          args(
            [
              ["--inbox", "room:r"],
              ["--inbox", "task:t"],
            ],
            ["Q"],
          ),
          reader,
        )
      ).input,
    ).toEqual({ query: "Q", inbox_ids: ["room:r", "task:t"] });
  });
});

describe("message ask-user", () => {
  const radio = { question: "Noodles or rice?", options: ["Noodles", "Rice"] };
  const ask = (questions: unknown, title = "Lunch order") =>
    command("ask-user").normalize(
      args([
        ["--title", title],
        ["--questions", JSON.stringify(questions)],
      ]),
      reader,
    );

  it("posts the questions as given", async () => {
    const questions = [
      radio,
      { question: "Sides?", options: ["Egg", "Tofu"], multiple: true },
    ];
    await expect(ask(questions)).resolves.toEqual({
      input: { title: "Lunch order", questions },
    });
  });
  it("keeps the title to one short line", async () => {
    await expect(ask([radio], "Lunch\norder")).rejects.toThrow(
      "--title must be one line of 1 to 120 characters.",
    );
  });
  it.each([
    [[], "--questions must be a JSON array of 1 to 20 questions."],
    [JSON.stringify([radio]), "not a string of encoded JSON"],
    [[{ prompt: "Why?" }], "questions[0] has invalid or unsupported fields."],
    [[{ ...radio, options: [] }], "questions[0].options must list 1 to 20"],
    [
      [{ question: "Anything else?" }],
      "ask an open question in an ordinary message instead",
    ],
    [
      [{ ...radio, multiple: "yes" }],
      "questions[0].multiple must be true or false.",
    ],
    [
      [{ ...radio, options: ["Rice", " Rice"] }],
      'questions[0].options[1] "Rice" repeats an earlier choice.',
    ],
  ])(
    "names the field a bad question breaks: %j",
    async (questions, message) => {
      await expect(ask(questions)).rejects.toThrow(message);
    },
  );
  it("is refused before any request in a Task", () => {
    expect(command("ask-user").unavailableInTask).toContain("final reply");
  });
  it("asks in a Thread of the configured Room", async () => {
    await expect(
      command("ask-user").normalize(
        args([
          ["--thread", "thread_one"],
          ["--title", "Venue"],
          ["--questions", JSON.stringify([radio])],
        ]),
        reader,
      ),
    ).resolves.toEqual({
      input: { thread_id: "thread_one", title: "Venue", questions: [radio] },
    });
  });
});

describe("message card", () => {
  const card = (entries: [string, string][]) =>
    command("card").normalize(
      args([["--title", "Done"], ["--content", "Result"], ...entries]),
      reader,
    );

  it("leaves the configured Room as the default destination", async () => {
    const normalized = await card([]);
    expect(normalized.target).toBeUndefined();
    expect(normalized.input).not.toHaveProperty("inbox_id");
  });
  it("delivers into a Thread of the configured Room", async () => {
    const normalized = await card([["--thread", "thread_one"]]);
    expect(normalized.target).toEqual({ type: "thread", id: "thread_one" });
    expect(normalized.input).toMatchObject({
      inbox_id: "thread:thread_one",
      card_title: "Done",
    });
  });
  it("takes a bare Thread ID", async () => {
    await expect(card([["--thread", "thread:thread_one"]])).rejects.toThrow(
      "Provide a bare resource ID after --thread.",
    );
  });
  it("marks a Personal Profile delivery with --kind profile", async () => {
    const normalized = await card([["--kind", "profile"]]);
    expect(normalized.input).toMatchObject({
      card_title: "Done",
      card_kind: "profile",
    });
  });
  it("sends no card kind without --kind", async () => {
    expect((await card([])).input).not.toHaveProperty("card_kind");
  });
  it("rejects any other card kind", async () => {
    await expect(card([["--kind", "report"]])).rejects.toThrow(
      "--kind must be profile.",
    );
  });
});
