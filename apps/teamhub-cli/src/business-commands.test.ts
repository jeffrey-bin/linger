import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CommandArguments,
  CommandInputReader,
} from "./command-definition.js";
import { businessCommandDefinitions } from "./business-commands.js";
import { renderBusinessResult } from "./business-render.js";
import {
  commandOptions,
  domainHelp,
  parseDomainCommand,
} from "./domain-commands.js";
import { runCli } from "./cli.js";
import { displayText } from "./display-text.js";
import { writeCliConfig } from "./test-support/cli-config.js";
import { personalProfileDocument } from "./test-support/command-examples.js";

const reader: CommandInputReader = {
  cwd: "/work",
  text: async (source) =>
    source === "body.md" ? "Keep Unicode café €\n" : "file body",
  json: async (source) =>
    source === "arguments.json"
      ? { query: "Research" }
      : source === "profile.json"
        ? personalProfileDocument
        : { type: "free_text" },
};
function args(
  options: Record<string, string | string[]> = {},
  positionals: string[] = [],
): CommandArguments {
  const entries = Object.entries(options).flatMap(([name, input]) =>
    (Array.isArray(input) ? input : [input]).map((value) => ({ name, value })),
  );
  return {
    positionals,
    ordered: entries,
    options: Object.fromEntries(
      Object.entries(options).map(([key, value]) => [
        key,
        Array.isArray(value) ? value : [value],
      ]),
    ),
  };
}
const command = (name: string) => {
  const definition = businessCommandDefinitions.find(
    (item) => item.command.join(" ") === name,
  );
  if (!definition) throw new Error(`Missing ${name}`);
  return definition;
};

async function rejectedBeforeIO(argv: string[]) {
  const fetcher = vi.fn<typeof fetch>();
  const readInput = vi.fn(async () => "unexpected file access");
  const stdout: string[] = [],
    stderr: string[] = [];
  const exitCode = await runCli([...argv, "--json"], {
    cwd: "/work",
    env: {
      TEAMHUB_URL: "https://teamhub.example",
      TEAMHUB_TOKEN: "th_agent_fixture",
    },
    fetch: fetcher,
    readInput,
    stdout: (value) => {
      stdout.push(value);
    },
    stderr: (value) => {
      stderr.push(value);
    },
  });
  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr.join("")).error.code).toBe("usage");
  expect(stdout).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(readInput).not.toHaveBeenCalled();
}

describe("business command recovery options", () => {
  it.each(businessCommandDefinitions.filter((item) => item.readOnly))(
    "does not offer an operation identity for read-only $command",
    (definition) => {
      expect(definition.operationId).toBe(false);
      expect(domainHelp(definition.command)).not.toContain("--operation-id");
    },
  );
  it.each(businessCommandDefinitions.filter((item) => item.readOnly))(
    "rejects operation identity before I/O for read-only $command",
    async (definition) => {
      const argv = [...definition.command, "--operation-id", "read_fixture"];
      await expect(
        parseDomainCommand(argv, { cwd: "/work", syntaxOnly: true }),
      ).rejects.toThrow("Unknown option: --operation-id.");
      await rejectedBeforeIO(argv);
    },
  );
  it.each(
    businessCommandDefinitions.filter(
      (item) => !item.readOnly && !item.fileRoute,
    ),
  )("retains operation identity for writing $command", async (definition) => {
    expect(definition.operationId).toBe(true);
    expect(commandOptions(definition)).toHaveProperty("--operation-id");
    expect(domainHelp(definition.command)).toContain("--operation-id");
    await expect(
      parseDomainCommand(
        [...definition.command, "--operation-id", "write_fixture"],
        { cwd: "/work", syntaxOnly: true },
      ),
    ).resolves.toMatchObject({ route: "commands" });
  });
});

describe("business command normalization", () => {
  it("renders current revisions and complete protocol content without filesystem projections", () => {
    expect(
      renderBusinessResult("room members", {
        room_id: "room_one",
        inbox_id: "room:room_one",
        membership_revision: 3,
        members: [
          {
            actor_id: "actor_one",
            kind: "agent",
            display_name: "Name\nInjected",
            agent_type: "general",
            description: "Reviews patches\nData only",
          },
        ],
      }),
    ).toContain(
      "actor_one  agent  Name\\nInjected  general  Reviews patches\\nData only",
    );
    const markdown = "# Protocol\n" + "€✓".repeat(3000);
    expect(
      renderBusinessResult("room protocol", {
        room_id: "room_one",
        revision: 4,
        updated_at: "2026-10-15T00:00:00Z",
        raw_markdown: markdown,
      }),
    ).toContain(markdown);
  });
  it("renders a one-shot routine at its run time", () => {
    expect(
      renderBusinessResult("routine list", {
        routines: [
          {
            id: "routine_one",
            name: "Check in",
            enabled: true,
            schedule: {
              kind: "once",
              timezone: "Asia/Shanghai",
              run_at: "2026-10-28T01:00:00Z",
            },
            next_run_at: "2026-10-28T01:00:00Z",
          },
        ],
      }),
    ).toContain("once at 2026-10-28T01:00:00Z");
  });
  it("renders an app listener routine by its app", () => {
    expect(
      renderBusinessResult("routine pause", {
        routine: {
          id: "routine_one",
          name: "Watch my inbox",
          enabled: false,
          listener: { app: "gmail" },
          instruction: "Tell me about new mail",
        },
      }),
    ).toContain("Schedule: listens to gmail");
  });
  it("reads current Room/Thread membership", async () => {
    const members = command("room members");
    expect(members.readOnly).toBe(true);
    expect(members.operationId).toBe(false);
    expect(members.defaultTarget).toBe("room");
    expect(
      await members.normalize(args({ "--thread": "thread_one" }), reader),
    ).toMatchObject({
      target: { type: "thread", id: "thread_one" },
      input: { inbox_id: "thread:thread_one" },
    });
    // Without --thread the configured Room supplies the Inbox in the CLI.
    expect(await members.normalize(args(), reader)).toEqual({ input: {} });
    expect(members.options).not.toHaveProperty("--room");
    const protocol = command("room protocol");
    expect(protocol.defaultTarget).toBe("room");
    expect(protocol.options).not.toHaveProperty("--room");
    expect(await protocol.normalize(args(), reader)).toEqual({ input: {} });
  });
  it("creates explicit unique member lists and equivalent initial message sources", async () => {
    const definition = command("room create");
    const direct = await definition.normalize(
      args({
        "--name": "Review",
        "--member-id": ["actor_one", "actor_two"],
        "--content": "Hello",
      }),
      reader,
    );
    const structured = await definition.normalize(
      args({
        "--name": "Review",
        "--member-ids": '["actor_one","actor_two"]',
        "--initial-message-segments": '[{"type":"text","content":"Hello"}]',
      }),
      reader,
    );
    expect(direct.input).toEqual(structured.input);
    await expect(
      definition.normalize(
        args({
          "--name": "Review",
          "--member-id": ["actor_one", "actor_one"],
          "--content": "Hello",
        }),
        reader,
      ),
    ).rejects.toThrow();
  });
  it("delegates a Task with a name and a plain-text requirement only", async () => {
    const definition = command("task create");
    expect(
      (
        await definition.normalize(
          args({ "--name": "Review", "--requirement": "Check the report." }),
          reader,
        )
      ).input,
    ).toEqual({ name: "Review", requirement: "Check the report." });
    expect(definition.options).not.toHaveProperty("--member-id");
    expect(definition.options).not.toHaveProperty("--title");
  });
  it("manages a delegated Task by ID from the Room Context", async () => {
    const check = command("task check");
    expect(check.readOnly).toBe(true);
    expect(check.defaultTarget).toBe("room");
    expect((await check.normalize(args(), reader)).input).toEqual({});
    expect(
      (await check.normalize(args({ "--task-id": "task_one" }), reader)).input,
    ).toEqual({ task_id: "task_one" });
    const send = command("task send");
    expect(send.defaultTarget).toBe("room");
    expect(
      (
        await send.normalize(
          args({ "--task-id": "task_one", "--message": "Use the Q3 data." }),
          reader,
        )
      ).input,
    ).toEqual({ task_id: "task_one", message: "Use the Q3 data." });
    expect(
      (
        await send.normalize(
          args({
            "--task-id": "task_one",
            "--message-file": "body.md",
            "--steer": "",
          }),
          reader,
        )
      ).input,
    ).toEqual({
      task_id: "task_one",
      message: "Keep Unicode café €\n",
      steer: true,
    });
    for (const options of [
      { "--task-id": "task_one" },
      { "--message": "x" },
      { "--task-id": "task_one", "--message": "x", "--message-file": "a" },
      { "--task-id": "task_one", "--message": "  " },
    ] as Record<string, string>[])
      await expect(send.normalize(args(options), reader)).rejects.toThrow();
    expect(
      (
        await command("task stop").normalize(
          args({ "--task-id": "task_one" }),
          reader,
        )
      ).input,
    ).toEqual({ task_id: "task_one" });
    await expect(
      command("task stop").normalize(args(), reader),
    ).rejects.toThrow();
  });
  it("requires exactly one schedule and explicit timezone without deduplicating weekdays", async () => {
    const definition = command("routine create");
    expect(
      (
        await definition.normalize(
          args({
            "--name": "Review",
            "--content": "Check evidence",
            "--weekly": "09:00",
            "--timezone": "Asia/Shanghai",
            "--weekday": ["monday", "friday"],
          }),
          reader,
        )
      ).input.schedule,
    ).toEqual({
      kind: "weekly",
      time: "09:00",
      timezone: "Asia/Shanghai",
      weekdays: ["monday", "friday"],
    });
    const invalidSchedules: Record<string, string | string[]>[] = [
      { "--daily": "09:00" },
      { "--every-hours": "2", "--timezone": "UTC" },
      {
        "--weekly": "09:00",
        "--timezone": "UTC",
        "--weekday": ["monday", "monday"],
      },
    ];
    for (const options of invalidSchedules)
      await expect(
        definition.normalize(
          args({ "--name": "Review", "--content": "Check", ...options }),
          reader,
        ),
      ).rejects.toThrow();
  });
  it("maps read section handles and only permits an offset with one section", async () => {
    const definition = command("knowledge read");
    const evidence = "raw_0123456789abcdef_0123456789abcdef";
    expect(
      (
        await definition.normalize(
          args({ "--section-id": ["part_one", "part_two"] }, [evidence]),
          reader,
        )
      ).input,
    ).toEqual({ evidenceId: evidence, sectionIds: ["part_one", "part_two"] });
    await expect(
      definition.normalize(
        args({ "--section-id": ["part_one", "part_two"], "--offset": "0" }, [
          evidence,
        ]),
        reader,
      ),
    ).rejects.toThrow();
  });
  it("reports an app write that TeamHub holds for confirmation", () => {
    const text = renderBusinessResult("apps execute", {
      confirmation: {
        status: "pending",
        roomId: "room_one",
        messageId: "message_card",
        interactionId: "interaction_one",
      },
    });
    expect(text).toContain("(card message_card)");
    expect(text).toContain("Do not run this command again");
    expect(renderBusinessResult("apps execute", { data: { id: 1 } })).toBe(
      'App tool result:\n{\n  "id": 1\n}',
    );
  });
  it("loads complete apps arguments from a JSON file and retains business names", async () => {
    const input = (
      await command("apps execute").normalize(
        args({
          "--connectionId": "connection_one",
          "--toolSlug": "NOTION_SEARCH",
          "--toolVersion": "20261013_01",
          "--arguments-file": "arguments.json",
        }),
        reader,
      )
    ).input;
    expect(input).toEqual({
      connectionId: "connection_one",
      toolSlug: "NOTION_SEARCH",
      toolVersion: "20261013_01",
      arguments: { query: "Research" },
    });
    expect(
      command("apps list").project?.({
        connections: [
          {
            connectionId: "connection_one",
            appKey: "notion",
            displayName: "Notion",
            identityLabel: "Personal",
          },
        ],
      }),
    ).toEqual({
      connections: [
        {
          connectionId: "connection_one",
          name: "notion",
          displayName: "Notion",
          identityLabel: "Personal",
        },
      ],
    });
  });
  it("renders Task status, approvals, activity and the last report", () => {
    const detail = renderBusinessResult("task check", {
      task: {
        task_id: "task_one",
        name: "Review",
        status: "waiting_for_approval",
        origin_room_id: "room_one",
        work_room_id: "room_work",
        created_at: "2026-10-27T01:00:00Z",
        status_since: "2026-10-27T01:05:00Z",
        recent_activity: [
          {
            at: "2026-10-27T01:05:00Z",
            kind: "waiting_for_approval",
            summary: "Run ended with 1 pending card",
          },
        ],
        pending_approvals: [
          {
            kind: "permission",
            id: "hi_one",
            title: "Run git push",
            created_at: "2026-10-27T01:04:00Z",
            expires_at: "2026-10-27T01:14:00Z",
          },
        ],
        last_report: { at: "2026-10-27T01:03:00Z", body: "Draft ready." },
        queued_message_count: 0,
      },
    });
    expect(detail).toContain("Task: Review (task_one)");
    expect(detail).toContain("Status: waiting_for_approval since");
    expect(detail).toContain(
      "permission: Run git push (expires 2026-10-27T01:14:00Z)",
    );
    expect(detail).toContain("Draft ready.");
    expect(
      renderBusinessResult("task check", {
        tasks: [
          {
            task_id: "task_one",
            name: "Review",
            status: "failed",
            reason: "agent_run_failed",
            created_at: "a",
            updated_at: "b",
          },
        ],
      }),
    ).toContain("task_one  Review  failed  agent_run_failed  b");
    expect(
      renderBusinessResult("task send", {
        accepted: true,
        task_id: "task_one",
        status: "running",
        delivery: "queued",
        duplicate_request: false,
      }),
    ).toBe("Message queued behind the running turn\nTask ID: task_one");
  });
});

describe("owner profile commands", () => {
  it("writes the whole Profile document from one JSON source with an optional base revision", async () => {
    const write = command("personal-profile write");
    await expect(write.normalize(args(), reader)).rejects.toThrow();
    expect(
      (
        await write.normalize(
          args({
            "--base-revision": "personal_profile_revision_one",
            "--file": "profile.json",
          }),
          reader,
        )
      ).input,
    ).toEqual({
      base_revision_id: "personal_profile_revision_one",
      profile: personalProfileDocument,
    });
    const inline = JSON.stringify(personalProfileDocument);
    expect(
      (
        await write.normalize(
          args({ "--content": inline, "--source-app": ["gmail", "github"] }),
          reader,
        )
      ).input,
    ).toEqual({
      profile: personalProfileDocument,
      source_apps: ["gmail", "github"],
    });
    await expect(
      write.normalize(args({ "--content": "# Owner" }), reader),
    ).rejects.toThrow("Provide one valid JSON value.");
    await expect(
      write.normalize(
        args({ "--content": inline, "--file": "profile.json" }),
        reader,
      ),
    ).rejects.toThrow("not both");
    await expect(
      write.normalize(
        args({
          "--content": JSON.stringify({ ...personalProfileDocument, extra: 1 }),
        }),
        reader,
      ),
    ).rejects.toThrow();
    expect(
      (await command("personal-profile show").normalize(args(), reader)).input,
    ).toEqual({});
  });
  it("updates only the given Account fields and requires one", async () => {
    const update = command("account-profile update");
    await expect(update.normalize(args(), reader)).rejects.toThrow(
      "Provide --name, --bio or --organization.",
    );
    expect(
      (await update.normalize(args({ "--bio": "Builds things." }), reader))
        .input,
    ).toEqual({ bio: "Builds things." });
  });
});

describe("agent commands", () => {
  async function run(
    argv: string[],
    response: unknown,
    kind: "room" | "task" = "room",
  ) {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response));
    const stdout: string[] = [],
      stderr: string[] = [];
    const state = await mkdtemp(path.join(tmpdir(), "cli-agent-"));
    try {
      const exitCode = await runCli(argv, {
        cwd: state,
        env: writeCliConfig(path.join(state, "config"), {
          scope: { kind, id: `${kind}_fixture` },
        }),
        fetch: fetcher,
        readInput: async () => "Review every patch.\n",
        stdout: (value) => {
          stdout.push(value);
        },
        stderr: (value) => {
          stderr.push(value);
        },
      });
      return {
        exitCode,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        fetcher,
        body: () =>
          JSON.parse(displayText(fetcher.mock.calls[0]![1]!.body)) as Record<
            string,
            unknown
          >,
        path: () => new URL(displayText(fetcher.mock.calls[0]![0])).pathname,
      };
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }

  it("reads one Agent with its complete prompt", async () => {
    const result = await run(["agent", "get", "--agent-id", "actor_two"], {
      actor_id: "actor_two",
      name: "Reviewer",
      description: "",
      prompt: "Review every patch.\nReport risks.",
    });
    expect(result.exitCode).toBe(0);
    expect(result.path()).toBe("/api/agent/v1/agents/get");
    expect(result.body()).toEqual({ actor_id: "actor_two" });
    expect(result.stdout).toBe(
      "Agent: Reviewer\nActor ID: actor_two\nDescription: —\nPrompt:\nReview every patch.\nReport risks.\n",
    );
  });

  it("creates an Agent from a prompt file and reports the Room it joined", async () => {
    const result = await run(
      [
        "agent",
        "create",
        "--name",
        "Reviewer",
        "--description",
        "Reviews patches",
        "--prompt-file",
        "-",
      ],
      { status: "applied", actor_id: "actor_two", room_id: "room_fixture" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.path()).toBe("/api/agent/v1/agents");
    expect(result.body()).toEqual({
      name: "Reviewer",
      description: "Reviews patches",
      prompt: "Review every patch.\n",
      invocation_id: expect.stringMatching(/^agent-invocation-sha256:/u),
    });
    expect(result.stdout).toBe(
      "Created Agent actor_two in Room room_fixture. Wake it with an Agent reference in that Room.\n",
    );
  });

  it("changes only the given fields and reports a pending card without failing", async () => {
    const result = await run(
      ["agent", "update", "--prompt", "Line one\\nLine two"],
      {
        status: "confirmation_pending",
        room_id: "room_fixture",
        message_id: "message_card",
        interaction_id: "interaction_one",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.path()).toBe("/api/agent/v1/agents/updates");
    expect(result.body()).toEqual({
      prompt: "Line one\nLine two",
      invocation_id: expect.stringMatching(/^agent-invocation-sha256:/u),
    });
    expect(result.stdout).toContain("(card message_card)");
    expect(result.stdout).toContain("expires after 24 hours");
    expect(result.stdout).toContain("Do not run this command again");
    expect(
      renderBusinessResult("agent update", {
        status: "applied",
        actor_id: "actor_two",
      }),
    ).toBe("Applied the change to Agent actor_two.");
  });

  it.each([
    [["agent", "update", "--agent-id", "actor_two"]],
    [["agent", "update", "--prompt", "One", "--prompt-file", "-"]],
    [["agent", "create", "--name", "Reviewer"]],
  ])("rejects %j before any request", async (argv) => {
    const result = await run(argv, {});
    expect(result.exitCode).toBe(2);
    expect(result.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["agent", "list"],
    ["agent", "get", "--agent-id", "actor_two"],
    ["agent", "create", "--name", "Reviewer", "--prompt", "Review."],
    ["agent", "update", "--name", "Reviewer"],
  ])("explains in a Task that the Meta must do %s %s", async (...argv) => {
    const result = await run([...argv, "--json"], {}, "task");
    expect(result.exitCode).toBe(4);
    expect(result.fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "forbidden",
      message:
        "A Task cannot list, read, create, or change Agents. Say what you need in your final reply; the Meta that started the Task can do it.",
    });
  });
});

describe("profile command text output", () => {
  it("renders an empty Personal Profile with how to create one", () => {
    expect(
      renderBusinessResult("personal-profile show", { current: null }),
    ).toBe(
      "No Personal Profile yet. Write one with teamhub personal-profile write (omit --base-revision).",
    );
  });
  it("renders the current Personal Profile as its editable JSON document", () => {
    const profile = {
      ...personalProfileDocument,
      name: "\u9879\u76ee Owner",
    };
    expect(
      renderBusinessResult("personal-profile show", {
        current: {
          revision_id: "revision_one",
          profile,
          markdown: "# rendered",
          created_at: "2026-10-30T00:00:00Z",
        },
      }),
    ).toBe(
      `Revision: revision_one\nCreated at: 2026-10-30T00:00:00Z\nSource apps: unknown\nProfile (edit this JSON and write the complete document back):\n${JSON.stringify(profile, null, 2)}`,
    );
  });
  it("renders a published Personal Profile revision", () => {
    expect(
      renderBusinessResult("personal-profile write", {
        revision_id: "revision_two",
        created_at: "2026-10-30T00:00:00Z",
      }),
    ).toBe(
      "Published Personal Profile revision revision_two at 2026-10-30T00:00:00Z.",
    );
  });
  it.each(["account-profile show", "account-profile update"])(
    "renders %s as single-line Account fields",
    (command) => {
      expect(
        renderBusinessResult(command, {
          name: "Alice",
          bio: "Line one\nLine two",
          organization: "",
        }),
      ).toBe("Name: Alice\nBio: Line one\\nLine two\nOrganization: ");
    },
  );
  it("renders a written Tracking Item with the revision for later edits", () => {
    expect(
      renderBusinessResult("tracking-items add", {
        id: "ti_1",
        status: "open",
        revision: 1,
        kind: "todo",
        content: "Reply to the lab",
        due_at: null,
        due_text: "next week",
      }),
    ).toBe(
      "Tracking Item ti_1 (open, revision 1)\nKind: todo\nContent: Reply to the lab\nDue: next week",
    );
  });
  it("fails loudly for a command without a text renderer", () => {
    expect(() => renderBusinessResult("unknown command", {})).toThrow(
      "No business renderer for unknown command",
    );
  });
  // Without --json the CLI reports a missing renderer as connection_failed,
  // even after a successful write. An empty result may fail on missing
  // fields; only the missing-renderer fallback is a defect.
  it.each(businessCommandDefinitions.map((item) => [item.command.join(" ")]))(
    "has a text renderer for %s",
    (command) => {
      const definition = businessCommandDefinitions.find(
        (item) => item.command.join(" ") === command,
      )!;
      try {
        definition.render?.({});
      } catch (error) {
        expect(String(error)).not.toContain("No business renderer");
      }
    },
  );
});
