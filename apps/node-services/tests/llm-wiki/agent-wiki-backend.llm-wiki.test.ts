import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentWikiBackend } from "../../src/llm-wiki/agent-wiki-backend.js";
import type {
  LlmWikiGenerateRequest,
  WikiInput,
} from "../../src/llm-wiki/backend.js";
import { PERSONAL_WIKI_NODE_TYPES } from "../../src/llm-wiki/personal-wiki-node-types.js";
import { rawSourceReference } from "../../src/llm-wiki/personal-wiki-policy.js";
import {
  renderWikiPage,
  strictWikiPageSchema,
  wikiPageFromStrictPayload,
} from "../../src/llm-wiki/wiki-page-template.js";
import { renderSessionSource } from "../../src/llm-wiki/wiki-session-source.js";
import {
  ModelCallError,
  type ModelChainCallRequest,
  type ModelChainSpec,
} from "../../src/runtime-model-call.js";
import { stubModelCall } from "../model-call-stub.js";

const temporaryDirectories: string[] = [];
const generator = { tenantId: "tenant_1", agentActorId: "another_me_1" };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-wiki-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function chatInput(inputsDirectory: string): Promise<WikiInput> {
  const raw = `## 10:00 · Zheng

Message metadata: {"message_id":"m1"}
We signed Acme Robotics as a client; their CTO Lina Park leads the pilot.

## 10:05 · Zheng

Message metadata: {"message_id":"m2"}
Lunch was good.
`;
  const { markdown, routing } = renderSessionSource("Room chat", raw, {
    kind: "room",
    date: "2026-11-03",
    sessionId: "room1",
    roomId: "room1",
    representedHumanActorId: "human_1",
    representedHumanDisplayName: "Zheng",
  });
  await mkdir(join(inputsDirectory, "chat"), { recursive: true });
  await writeFile(join(inputsDirectory, "chat", "document.md"), markdown);
  return {
    assetKey: "chat",
    contentPath: "chat/document.md",
    contentSha256: "0".repeat(64),
    sourceUrl: "document://session1/versions/v1",
    title: "Room chat",
    session: routing,
  };
}

async function meetingInput(inputsDirectory: string): Promise<WikiInput> {
  const { markdown, routing } = renderSessionSource(
    "Weekly sync",
    "Speaker 1: Acme Robotics wants the pilot report by Friday.",
    {
      kind: "recording",
      date: "2026-11-03",
      sessionId: "rec1",
      roomId: "room1",
      transcriptDocumentId: "doc9",
      transcriptDocumentVersionId: "v9",
      representedHumanActorId: "human_1",
      representedHumanDisplayName: "Zheng",
    },
  );
  await mkdir(join(inputsDirectory, "meeting"), { recursive: true });
  await writeFile(join(inputsDirectory, "meeting", "document.md"), markdown);
  return {
    assetKey: "meeting",
    contentPath: "meeting/document.md",
    contentSha256: "1".repeat(64),
    sourceUrl: "document://session2/versions/v1",
    title: "Weekly sync",
    session: routing,
  };
}

function clientPayload(ref: string) {
  return {
    title: "Acme Robotics",
    description: "Client running a pilot.",
    fields: {
      client_name: "Acme Robotics",
      organization: "Acme Robotics",
      aliases: ["Acme"],
    },
    sections: {
      "Basic Info": {
        text: `Signed as a client. [[source:${ref}]]`,
        reason: "The contract was signed.",
      },
      "Collaboration Style": {
        text: "Works through a pilot led by its CTO.",
        reason: "The CTO leads the pilot.",
      },
      "Needs And Constraints": {
        text: "Needs a successful pilot.",
        reason: "The pilot decides the deal.",
      },
      Related: [],
      "Open Items": [{ text: `Pilot in progress. [[source:${ref}]]` }],
      "Closed Items": [
        { text: `2026-11-03: Signed as a client. [[source:${ref}]]` },
      ],
    },
    source_refs: [ref],
    relations: [{ kind: "contacts", page: "contacts/lina.md" }],
  };
}

function sessionPayload(ref: string) {
  return {
    title: "Weekly sync",
    description: "Weekly sync about the Acme pilot.",
    fields: { session_id: "rec1", date: "2026-11-03", source_kind: "meeting" },
    sections: {
      "Objective Summary": `Reviewed the Acme pilot. [[source:${ref}]]`,
      Keywords: ["Acme", "pilot"],
      "Meeting Summary": `### Pilot\n\nAcme wants the report by Friday. [[source:${ref}]]`,
      "Main Topics": `### Pilot report\n\nDue Friday. [[source:${ref}]]`,
      "Decisions And Outcomes": [],
      "Action Items": [
        {
          owner: null,
          deadline: "Friday",
          resources: null,
          priority: null,
          text: "Send the pilot report",
          evidence: `Requested by Acme [[source:${ref}]]`,
        },
      ],
      Pattern: [],
    },
    source_refs: [ref],
    relations: [],
    source_readable: true,
  };
}

/** Answers each task by its kind, as the model would. With `topic`, routing
 * also names a topic whose page the batch first leaves out, then skips. */
function fakeModel(topic = false) {
  const requests: ModelChainCallRequest[] = [];
  const tasks: ModelChainSpec[] = [];
  const call = vi.fn(async (request: ModelChainCallRequest) => {
    requests.push(request);
    const refs = [
      ...request.input.matchAll(/\[\[source:(raw:S[0-9a-f]+)\]\]/gu),
    ].map((match) => match[1]!);
    if (request.instructions!.includes("Write the Session page of one meeting"))
      return {
        model: "test",
        output: {
          actions: [
            {
              tool: "propose",
              object: "wiki.session",
              target: "sessions/2026-11-03/rec1.md",
              payload: sessionPayload(refs[0]!),
            },
            {
              tool: "add_todo",
              arguments: {
                type: "client",
                page: null,
                name: "Acme Robotics",
                slug: "acme-robotics",
                refs: [refs[0]!],
                note: "Wants the pilot report by Friday.",
              },
            },
            { tool: "finish", summary: "done" },
          ],
        },
      };
    if (
      request.instructions!.includes("Write the durable Wiki pages") &&
      request.input.includes("Not done yet")
    )
      return {
        model: "test",
        output: {
          actions: [
            {
              tool: "skip_page",
              arguments: {
                path: "topics/pilot-program.md",
                reason: "Nothing durable beyond the client page.",
              },
            },
            { tool: "finish", summary: "written" },
          ],
        },
      };
    if (request.instructions!.includes("Write the durable Wiki pages"))
      return {
        model: "test",
        output: {
          actions: [
            {
              tool: "propose",
              object: "wiki.client.new",
              target: "clients/acme-robotics.md",
              payload: clientPayload(refs[0]!),
            },
            { tool: "finish", summary: "written" },
          ],
        },
      };
    return {
      model: "test",
      output: {
        actions: [
          {
            tool: "add_todo",
            arguments: {
              type: "client",
              page: null,
              name: "Acme Robotics",
              slug: "acme-robotics",
              refs: [refs[0]!],
              note: "Signed as a client.",
            },
          },
          ...(topic
            ? [
                {
                  tool: "add_todo",
                  arguments: {
                    type: "topic",
                    page: null,
                    name: "Pilot program",
                    slug: "pilot-program",
                    refs: [refs[0]!],
                    note: "The pilot Acme runs.",
                  },
                },
              ]
            : []),
          { tool: "finish", summary: "routed" },
        ],
      },
    };
  });
  const modelCall = stubModelCall({
    chain: (spec, body) => {
      tasks.push(spec);
      return body({
        signal: new AbortController().signal,
        call,
        text: () => Promise.reject(new Error("unused")),
        workspace: () => Promise.reject(new Error("unused")),
      });
    },
  });
  return { modelCall, requests, tasks };
}

async function generate(
  inputs: (directory: string) => Promise<WikiInput[]>,
  model = fakeModel(),
  existing: Record<string, string> = {},
  extra: Partial<LlmWikiGenerateRequest> = {},
) {
  const root = await temporary();
  const inputsDirectory = join(root, "inputs");
  const changes = await inputs(inputsDirectory);
  for (const [path, content] of Object.entries(existing)) {
    await mkdir(join(root, "existing", path, ".."), { recursive: true });
    await writeFile(join(root, "existing", path), content);
  }
  const previews = new Map<string, string | null>();
  const request: LlmWikiGenerateRequest = {
    onPreviewPage: (path, content) => {
      previews.set(path, content);
    },
    changes: { added: changes, modified: [], removed: [] },
    generator,
    existingOutputDirectory: join(root, "existing"),
    inputsDirectory,
    mode: "update",
    outputDirectory: join(root, "output"),
    ...extra,
  };
  const backend = new AgentWikiBackend({
    modelCall: () => model.modelCall,
  });
  const result = await backend.generate(request);
  const files = (await readdir(request.outputDirectory, { recursive: true }))
    .filter((path) => path.endsWith(".md"))
    .sort();
  return {
    result,
    files,
    request,
    previews,
    requests: model.requests,
    tasks: model.tasks,
  };
}

describe("AgentWikiBackend", () => {
  it("routes a chat to an entity page without a Session page for the chat", async () => {
    const { files, request, requests, tasks, previews } = await generate(
      async (directory) => [await chatInput(directory)],
    );
    // Each routing pack and page batch is its own queued chain.
    expect(tasks).toEqual([
      expect.objectContaining({
        kind: "wiki",
        key: expect.stringMatching(/\/route:1$/u),
        anotherMe: generator,
      }),
      expect.objectContaining({
        kind: "wiki",
        key: expect.stringMatching(/\/batch:1$/u),
        anotherMe: generator,
      }),
    ]);
    expect(requests.map((entry) => entry.step)).toEqual([
      "route:1/1",
      "batch:1:write:0/1",
    ]);
    expect(files).toEqual([
      "clients/acme-robotics.md",
      "clients/index.md",
      "index.md",
    ]);
    const page = await readFile(
      join(request.outputDirectory, "clients/acme-robotics.md"),
      "utf8",
    );
    expect(page).toContain("teamhub://rooms/room1/messages/m1");
    expect(page).toContain("# Acme Robotics");
    expect(previews.get("clients/acme-robotics.md")).toContain(
      "# Acme Robotics",
    );
    expect(requests.map((entry) => entry.schemaName)).toEqual([
      "memory_agent_step",
      "memory_agent_step",
    ]);
    // The writer reads the routed message with its neighbor, not the metadata.
    expect(requests[1]!.input).toContain("We signed Acme Robotics");
    expect(requests[1]!.input).not.toContain("Message metadata");
  });

  it("caps each step's reply and skips a batch that runs away past its attempts", async () => {
    const model = fakeModel();
    const answer = model.modelCall;
    const runaway = vi.fn(async (request: ModelChainCallRequest) => {
      if (request.instructions!.includes("Write the durable Wiki pages"))
        throw new ModelCallError("output_limited", "ran on", {
          output: '{"actions":[',
        });
      return undefined;
    });
    const modelCall = stubModelCall({
      chain: (spec, body) =>
        answer.chain(spec, (task) =>
          body({
            ...task,
            call: async (request) =>
              (await runaway(request)) ?? task.call(request),
          }),
        ),
    });
    const { files, requests, result, request } = await generate(
      async (directory) => [await chatInput(directory)],
      { ...model, modelCall },
    );
    expect(requests.map((entry) => [entry.step, entry.maxOutputChars])).toEqual(
      [["route:1/1", 36_000]],
    );
    // Its source stays pending so a later refresh writes the page.
    expect(result.unsettled).toEqual([request.changes.added[0]!.assetKey]);
    expect(
      runaway.mock.calls.map(([request]) => [
        request.step,
        request.maxOutputChars,
        request.timeoutMs,
      ]),
    ).toEqual([
      ["route:1/1", 36_000, 15 * 60_000],
      ["batch:1:write:0/1", 36_000, 15 * 60_000],
    ]);
    // The client page waits for a later refresh; the generation still publishes.
    expect(files).not.toContain("clients/acme-robotics.md");
    expect(files).toContain("index.md");
  });

  it("skips a routing task that stalls past its attempts and keeps its sources pending", async () => {
    const model = fakeModel();
    const answer = model.modelCall;
    const modelCall = stubModelCall({
      chain: (spec, body) =>
        answer.chain(spec, (task) =>
          body({
            ...task,
            call: async (request) => {
              if (request.step.startsWith("route:"))
                throw new ModelCallError("timed_out", "stalled");
              return task.call(request);
            },
          }),
        ),
    });
    const { files, result, request } = await generate(
      async (directory) => [await chatInput(directory)],
      { ...model, modelCall },
    );
    expect(result.unsettled).toEqual([request.changes.added[0]!.assetKey]);
    expect(files).toEqual(["index.md"]);
  });

  it("skips a meeting that stalls twice without requiring its Session page", async () => {
    const model = fakeModel();
    const answer = model.modelCall;
    const modelCall = stubModelCall({
      chain: (spec, body) =>
        answer.chain(spec, (task) =>
          body({
            ...task,
            call: async (request) => {
              if (request.step.startsWith("meeting:"))
                throw new ModelCallError("timed_out", "stalled");
              return task.call(request);
            },
          }),
        ),
    });
    const { files, result, request } = await generate(
      async (directory) => [await meetingInput(directory)],
      { ...model, modelCall },
    );
    expect(result.unsettled).toEqual([request.changes.added[0]!.assetKey]);
    expect(files).not.toContain("sessions/2026-11-03/rec1.md");
  });

  it("starts no task past the refresh deadline and defers every source", async () => {
    const model = fakeModel();
    const { files, result, request, requests } = await generate(
      async (directory) => [await chatInput(directory)],
      model,
      {},
      { deadline: Date.now() - 1 },
    );
    expect(requests).toEqual([]);
    // Deferred, not unsettled: the source spends none of its tries.
    expect(result.unsettled).toEqual([]);
    expect(result.deferred).toEqual([request.changes.added[0]!.assetKey]);
    expect(files).toEqual(["index.md"]);
  });

  it("writes the pages of shared evidence in one task and lets it skip one", async () => {
    const { files, requests } = await generate(
      async (directory) => [await chatInput(directory)],
      fakeModel(true),
    );
    // Two new entities: one consolidation call settles them before writing.
    expect(requests.map((entry) => entry.step)).toEqual([
      "route:1/1",
      "consolidate/1",
      "batch:1:write:0/1",
      "batch:1:write:0/2",
    ]);
    // Every step is one stateless call in a session of its own that
    // carries the task input again.
    const sessions = requests.map((entry) => entry.sessionKey);
    expect(sessions.every(Boolean)).toBe(true);
    expect(new Set(sessions).size).toBe(sessions.length);
    expect(requests[3]!.input).toContain("# Evidence");
    // Both pages are in the one task; its finish waits for the topic.
    expect(requests[2]!.input).toContain("topics/pilot-program.md (new page");
    expect(requests[3]!.input).toContain(
      "Not done yet: propose or skip_page topics/pilot-program.md",
    );
    expect(files).toEqual([
      "clients/acme-robotics.md",
      "clients/index.md",
      "index.md",
    ]);
  });

  it("splits a new batch whose pages leave no room for evidence", async () => {
    const model = fakeModel(true);
    // A small model: one page's fixed text already fills a task.
    const modelCall = { ...model.modelCall, contextWindow: async () => 10_000 };
    const { requests } = await generate(
      async (directory) => [await chatInput(directory)],
      { ...model, modelCall },
    );
    const batches = new Set(
      requests
        .filter((entry) => entry.step.startsWith("batch:"))
        .map((entry) => entry.step.split(":")[1]),
    );
    expect(batches).toEqual(new Set(["1", "2"]));
  });

  it("drops links to pages that are gone without counting them as changes", async () => {
    const topic = PERSONAL_WIKI_NODE_TYPES.get("topic")!;
    const ref = rawSourceReference("teamhub://rooms/room0/messages/m0");
    // An older page, in a layout a changed page may no longer use, links a
    // chat Session page the migration deleted. Dropping the link must not
    // make it a changed page.
    const legacy = `${renderWikiPage(
      "topics/robotics.md",
      wikiPageFromStrictPayload(topic, {
        title: "Robotics",
        description: "Robotics work.",
        fields: { topic_name: "Robotics", aliases: [] },
        sections: {
          Overview: { text: `Robotics. [[source:${ref}]]`, reason: "first" },
          "Current Understanding": {
            text: `Pilots. [[source:${ref}]]`,
            reason: "first",
          },
          Related: [],
        },
        source_refs: [ref],
        relations: [],
      }),
      new Map([[ref, "teamhub://rooms/room0/messages/m0"]]),
    ).replace(
      "## Current Understanding",
      "## Notes",
    )}\nSee the [old chat](../sessions/2026-11-02/room_old.md).\n`;
    const { files, request } = await generate(
      async (directory) => [await chatInput(directory)],
      fakeModel(),
      { "index.md": "# Index\n", "topics/robotics.md": legacy },
    );
    expect(files).toContain("topics/robotics.md");
    const page = await readFile(
      join(request.outputDirectory, "topics/robotics.md"),
      "utf8",
    );
    expect(page).toContain("old chat");
    expect(page).not.toContain("room_old.md");
  });

  it("writes a meeting's Session page and the entities it routes", async () => {
    const { files, request, requests } = await generate(async (directory) => [
      await meetingInput(directory),
    ]);
    expect(
      requests.find((entry) => entry.step.startsWith("meeting:")),
    ).toMatchObject({ timeoutMs: 15 * 60_000, maxOutputChars: 96_000 });
    expect(files).toEqual([
      "clients/acme-robotics.md",
      "clients/index.md",
      "index.md",
      "sessions/2026-11-03/index.md",
      "sessions/2026-11-03/rec1.md",
      "sessions/index.md",
    ]);
    const session = await readFile(
      join(request.outputDirectory, "sessions/2026-11-03/rec1.md"),
      "utf8",
    );
    expect(session).toContain("teamhub://documents/doc9/versions/v9");
  });
});

describe("AgentWikiBackend long meetings", () => {
  /** A meeting of 40 long paragraphs, about 16,000 tokens. */
  async function longMeeting(inputsDirectory: string): Promise<WikiInput> {
    const input = await meetingInput(inputsDirectory);
    const transcript = Array.from(
      { length: 40 },
      (_, index) =>
        `Speaker ${(index % 3) + 1}: point ${index + 1} about the Acme pilot. ${"The pilot report needs the latest numbers. ".repeat(28)}`,
    ).join("\n\n");
    const { markdown } = renderSessionSource("Weekly sync", transcript, {
      kind: "recording",
      date: "2026-11-03",
      sessionId: "rec1",
      roomId: "room1",
      transcriptDocumentId: "doc9",
      transcriptDocumentVersionId: "v9",
      representedHumanActorId: "human_1",
      representedHumanDisplayName: "Zheng",
    });
    await writeFile(join(inputsDirectory, "meeting", "document.md"), markdown);
    return input;
  }

  async function generateLong(
    model: ReturnType<typeof fakeModel>,
    loopTokens = 5_000,
  ) {
    const root = await temporary();
    const inputsDirectory = join(root, "inputs");
    const request: LlmWikiGenerateRequest = {
      changes: {
        added: [await longMeeting(inputsDirectory)],
        modified: [],
        removed: [],
      },
      generator,
      existingOutputDirectory: join(root, "existing"),
      inputsDirectory,
      mode: "update",
      outputDirectory: join(root, "output"),
    };
    // A small model: tasks take half its window, and 5,000 leaves only the
    // minimum evidence per task.
    const modelCall = {
      ...model.modelCall,
      contextWindow: async () => 2 * loopTokens,
    };
    const backend = new AgentWikiBackend({ modelCall: () => modelCall });
    await backend.generate(request);
    return model.requests.filter((entry) => entry.step.startsWith("meeting:"));
  }

  it("writes a transcript longer than one task in parts, each updating the page so far", async () => {
    const meetings = await generateLong(fakeModel());
    expect(meetings.length).toBeGreaterThan(2);
    expect(meetings[0]!.input).toContain("This is part 1");
    expect(meetings[0]!.input).toContain("This page does not exist yet.");
    // Later parts read the page the earlier parts staged.
    expect(meetings[1]!.input).toContain(
      `This is part 2 of ${meetings.length}`,
    );
    expect(meetings[1]!.input).toContain("Reviewed the Acme pilot.");
    expect(meetings[1]!.input).not.toContain("This page does not exist yet.");
    // Every part holds a different slice of the transcript.
    expect(meetings.at(-1)!.input).toContain("point 40 about the Acme pilot");
    expect(meetings[0]!.input).not.toContain("point 40 about the Acme pilot");
  });

  it("halves the parts when one is still too large for the model", async () => {
    // Room for more than the minimum evidence, so a part can shrink.
    const loopTokens = 52_000;
    const whole = (await generateLong(fakeModel(), loopTokens)).length;
    const model = fakeModel();
    const answer = model.modelCall;
    let rejected = 0;
    const original = answer.chain.bind(answer);
    model.modelCall = {
      ...answer,
      chain: (spec, body) =>
        original(spec, (task) =>
          body({
            ...task,
            call: async (request) => {
              if (
                request.step.startsWith("meeting:") &&
                request.step.includes(":write:0") &&
                rejected === 0
              ) {
                rejected += 1;
                throw new ModelCallError(
                  "invalid_request",
                  "prompt is too long",
                );
              }
              return task.call(request);
            },
          }),
        ),
    };
    const meetings = await generateLong(model, loopTokens);
    expect(whole).toBeGreaterThan(1);
    expect(rejected).toBe(1);
    // The rejected attempt is retried from part 1 with shorter parts.
    const halved = meetings.filter((entry) => entry.step.includes(":write:1"));
    expect(halved.length).toBeGreaterThan(whole);
    expect(halved[0]!.input).toContain("This is part 1");
  });
});

describe("AgentWikiBackend entities named twice", () => {
  /** A Room chat long enough that two of them need two routing tasks. */
  async function namedChat(
    inputsDirectory: string,
    room: string,
    text: string,
  ): Promise<WikiInput> {
    const filler = "The migration plan needs review. ".repeat(100);
    const raw = `## 10:00 · Zheng

Message metadata: {"message_id":"m1"}
${text} ${filler}

## 10:05 · Zheng

Message metadata: {"message_id":"m2"}
${filler}
`;
    const { markdown, routing } = renderSessionSource(`${room} chat`, raw, {
      kind: "room",
      date: "2026-11-03",
      sessionId: room,
      roomId: room,
      representedHumanActorId: "human_1",
      representedHumanDisplayName: "Zheng",
    });
    await mkdir(join(inputsDirectory, room), { recursive: true });
    await writeFile(join(inputsDirectory, room, "document.md"), markdown);
    return {
      assetKey: room,
      contentPath: `${room}/document.md`,
      contentSha256: "0".repeat(64),
      sourceUrl: `document://${room}/versions/v1`,
      title: `${room} chat`,
      session: routing,
    };
  }

  /** Each routing task names the client in its chat its own way; the writer
   * writes every page it is given, citing all its evidence. */
  function namingModel(
    names: Record<string, { name: string; slug: string }>,
    merges: ReadonlyArray<{ keep: string; merge: string[] }> = [],
  ) {
    const requests: ModelChainCallRequest[] = [];
    const call = vi.fn(async (request: ModelChainCallRequest) => {
      requests.push(request);
      if (request.instructions!.includes("Settle the new entities")) {
        const listed = new Map(
          [...request.input.matchAll(/^- \[(\d+)\] \w+ "([^"]+)"/gmu)].map(
            ([, index, name]) => [name!, Number(index)],
          ),
        );
        return {
          model: "test",
          output: {
            actions: [
              ...merges.map((group) => ({
                tool: "merge_entities",
                arguments: {
                  keep: listed.get(group.keep)!,
                  page: null,
                  merge: group.merge.map((name) => listed.get(name)!),
                  reason: "One company.",
                },
              })),
              { tool: "finish", summary: "settled" },
            ],
          },
        };
      }
      const refs = [
        ...new Set(
          [...request.input.matchAll(/\[\[source:(raw:S[0-9a-f]+)\]\]/gu)].map(
            (match) => match[1]!,
          ),
        ),
      ];
      if (request.instructions!.includes("Write the durable Wiki pages")) {
        const pages = [
          ...request.input.matchAll(
            /^## \d+\. (.+)\n\nType: client\nPath: (\S+) /gmu,
          ),
        ];
        return {
          model: "test",
          output: {
            actions: [
              ...pages.map(([, name, path]) => ({
                tool: "propose",
                object: "wiki.client.new",
                target: path!,
                payload: {
                  ...clientPayload(refs[0]!),
                  title: name!,
                  fields: {
                    client_name: name!,
                    organization: name!,
                    aliases: Object.values(names)
                      .map((entry) => entry.name)
                      .filter((alias) => alias !== name),
                  },
                  sections: {
                    ...clientPayload(refs[0]!).sections,
                    "Closed Items": refs.map((ref) => ({
                      text: `2026-11-03: Discussed the migration. [[source:${ref}]]`,
                    })),
                  },
                  source_refs: refs,
                  relations: [],
                },
              })),
              { tool: "finish", summary: "written" },
            ],
          },
        };
      }
      const room = Object.keys(names).find((key) =>
        request.input.includes(`id="${key}"`),
      )!;
      return {
        model: "test",
        output: {
          actions: [
            {
              tool: "add_todo",
              arguments: {
                type: "client",
                page: null,
                ...names[room]!,
                refs: [refs[0]!],
                note: "Discussed the migration.",
              },
            },
            { tool: "finish", summary: "routed" },
          ],
        },
      };
    });
    const running = { now: 0, most: 0 };
    const modelCall = {
      ...stubModelCall({
        chain: async (_spec, body) => {
          running.most = Math.max(running.most, ++running.now);
          try {
            return await body({
              signal: new AbortController().signal,
              call,
              text: () => Promise.reject(new Error("unused")),
              workspace: () => Promise.reject(new Error("unused")),
            });
          } finally {
            running.now -= 1;
          }
        },
      }),
      // Each routing task then holds one chat.
      contextWindow: async () => 10_000,
    };
    return { modelCall, requests, running };
  }

  async function generateNamed(
    names: Record<string, { name: string; slug: string }>,
    merges: ReadonlyArray<{ keep: string; merge: string[] }> = [],
  ) {
    const root = await temporary();
    const inputsDirectory = join(root, "inputs");
    const request: LlmWikiGenerateRequest = {
      changes: {
        added: [
          await namedChat(inputsDirectory, "rooma", "AWS hosts our pilot."),
          await namedChat(
            inputsDirectory,
            "roomb",
            "アマゾン ウェブ サービス signed the migration contract.",
          ),
        ],
        modified: [],
        removed: [],
      },
      generator,
      existingOutputDirectory: join(root, "existing"),
      inputsDirectory,
      mode: "initialize",
      outputDirectory: join(root, "output"),
    };
    const model = namingModel(names, merges);
    await new AgentWikiBackend({ modelCall: () => model.modelCall }).generate(
      request,
    );
    const files = (await readdir(request.outputDirectory, { recursive: true }))
      .filter((path) => path.startsWith("clients/") && !isIndex(path))
      .sort();
    return {
      files,
      request,
      requests: model.requests,
      running: model.running,
    };
  }

  function isIndex(path: string): boolean {
    return path.endsWith("index.md");
  }

  it("writes one page from both sources when two routing tasks name one entity differently", async () => {
    const { files, request, requests, running } = await generateNamed({
      rooma: { name: "AWS", slug: "aws" },
      roomb: { name: "アマゾン ウェブ サービス", slug: "aws" },
    });
    expect(
      requests
        .map((entry) => entry.step)
        .filter((step) => step.startsWith("route:")),
    ).toEqual(["route:1/1", "route:2/1"]);
    // Both routing chains are queued at once; the queue decides the order.
    expect(running.most).toBe(2);
    expect(files).toEqual(["clients/aws.md"]);
    const writer = requests.find((entry) => entry.step.startsWith("batch:"))!;
    expect(writer.input).toContain(
      'Also named "アマゾン ウェブ サービス" in the evidence; keep that name as an alias.',
    );
    const page = await readFile(
      join(request.outputDirectory, "clients/aws.md"),
      "utf8",
    );
    expect(page).toContain("teamhub://rooms/rooma/messages/m1");
    expect(page).toContain("teamhub://rooms/roomb/messages/m1");
  });

  it("merges two names for one new entity before any page is written", async () => {
    const { files, request, requests } = await generateNamed(
      {
        rooma: { name: "AWS", slug: "aws" },
        roomb: {
          name: "アマゾン ウェブ サービス",
          slug: "amazon-web-services",
        },
      },
      [{ keep: "AWS", merge: ["アマゾン ウェブ サービス"] }],
    );
    const consolidate = requests.find((entry) =>
      entry.step.startsWith("consolidate"),
    )!;
    expect(consolidate.input).toContain('client "AWS" (slug aws');
    expect(consolidate.input).toContain(
      'client "アマゾン ウェブ サービス" (slug amazon-web-services',
    );
    expect(files).toEqual(["clients/aws.md"]);
    expect(requests.some((entry) => entry.step.startsWith("fix:"))).toBe(false);
    const writer = requests.find((entry) => entry.step.startsWith("batch:"))!;
    expect(writer.input).toContain(
      'Also named "アマゾン ウェブ サービス" in the evidence; keep that name as an alias.',
    );
    const page = await readFile(
      join(request.outputDirectory, "clients/aws.md"),
      "utf8",
    );
    expect(page).toContain("teamhub://rooms/rooma/messages/m1");
    expect(page).toContain("teamhub://rooms/roomb/messages/m1");
  });

  it("keeps one of two new pages that still share an identity after correction", async () => {
    const { files, requests } = await generateNamed({
      rooma: { name: "AWS", slug: "aws" },
      roomb: { name: "アマゾン ウェブ サービス", slug: "amazon-web-services" },
    });
    // Correction rewrote both pages and still left them duplicates.
    expect(
      requests.filter((entry) => entry.step.startsWith("fix:")),
    ).toHaveLength(2);
    expect(files).toEqual(["clients/amazon-web-services.md"]);
  });
});

describe("strictWikiPageSchema", () => {
  it("round-trips every registered type through the page renderer", () => {
    const ref = rawSourceReference("teamhub://rooms/r1/messages/m1");
    const references = new Map([[ref, "teamhub://rooms/r1/messages/m1"]]);
    const client = PERSONAL_WIKI_NODE_TYPES.get("client")!;
    expect(strictWikiPageSchema(client)).toMatchObject({
      additionalProperties: false,
      required: [
        "title",
        "description",
        "fields",
        "sections",
        "source_refs",
        "relations",
      ],
    });
    const markdown = renderWikiPage(
      "clients/acme.md",
      wikiPageFromStrictPayload(client, clientPayload(ref)),
      references,
    );
    expect(markdown).toContain("## Closed Items");
    expect(markdown).not.toContain("## Interaction History");
    const session = PERSONAL_WIKI_NODE_TYPES.get("session")!;
    const sessionMarkdown = renderWikiPage(
      "sessions/2026-11-03/rec1.md",
      wikiPageFromStrictPayload(session, sessionPayload(ref)),
      references,
    );
    expect(sessionMarkdown).toContain("Deadline: Friday");
    expect(sessionMarkdown).not.toContain("null");
  });

  it("drops source markers outside the sections", () => {
    const client = PERSONAL_WIKI_NODE_TYPES.get("client")!;
    expect(
      wikiPageFromStrictPayload(client, {
        title: "Acme [[source:raw:S1]]",
        description: "Client. [[source:raw:S1]] [[source:raw:S2]]",
        fields: { organization: "Acme [[source:raw:S1]]", aliases: ["A"] },
        sections: {
          "Basic Info": { text: "Signed. [[source:raw:S1]]", reason: "r" },
        },
        relations: [
          { kind: "contacts", page: "contacts/lina.md [[source:raw:S1]]" },
        ],
      }),
    ).toMatchObject({
      title: "Acme",
      description: "Client.",
      fields: { organization: "Acme", aliases: ["A"] },
      sections: {
        "Basic Info": { text: "Signed. [[source:raw:S1]]", reason: "r" },
      },
      relations: { contacts: ["contacts/lina.md"] },
    });
  });

  it("keeps, rewrites and retracts summaries, and maps relations by kind", () => {
    const client = PERSONAL_WIKI_NODE_TYPES.get("client")!;
    const page = wikiPageFromStrictPayload(client, {
      sections: {
        "Basic Info": { keep: true },
        "Collaboration Style": { text: "x", reason: "The CTO now leads." },
        "Needs And Constraints": {
          removed_refs: ["raw:S2", "raw:S2"],
          reason: "The deleted mail was the only source.",
          text: "y",
        },
        Related: [{ merge: ["i1", "i2", "i1"], text: "merged" }],
      },
      fields: { aliases: ["A", "A"] },
      source_refs: ["r", "r"],
      relations: [
        { kind: "contacts", page: "a" },
        { kind: "contacts", page: "a" },
        { kind: "topics", page: "topics/t.md" },
        { kind: "clients", page: "not allowed on a client" },
      ],
    });
    expect(page).toMatchObject({
      sections: {
        "Basic Info": { keep: true },
        "Collaboration Style": { text: "x", reason: "The CTO now leads." },
        "Needs And Constraints": {
          removed_refs: ["raw:S2"],
          reason: "The deleted mail was the only source.",
          text: "y",
        },
        Related: [{ merge: ["i1", "i2"], text: "merged" }],
      },
      fields: { aliases: ["A"] },
      source_refs: ["r"],
    });
    expect(page.relations).toEqual({
      contacts: ["a"],
      projects: [],
      topics: ["topics/t.md"],
    });
  });

  // Structured output must write every key of a strict object before it may
  // close it. A model that wants to stop where the schema still demands keys
  // it has no use for streams whitespace, sometimes until its output limit.
  it("never makes the model write a key it may leave out after the content", () => {
    const optional = (schema: Record<string, unknown>) => {
      const type = schema.type;
      return (
        (Array.isArray(type) && type.includes("null")) ||
        (type === "array" && !schema.minItems)
      );
    };
    const problems: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node))
        return node.forEach((child) => walk(child, path));
      if (!node || typeof node !== "object") return;
      const schema = node as Record<string, unknown>;
      const properties = schema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (schema.type === "object" && properties) {
        const keys = Object.keys(properties);
        const nullable = keys.map((key) => {
          const type = properties[key]!.type;
          return Array.isArray(type) && type.includes("null");
        });
        const firstContent = nullable.indexOf(false);
        if (firstContent >= 0 && nullable.slice(firstContent).includes(true))
          problems.push(`${path}: a nullable key follows content`);
        if (keys.length > 1 && keys.every((key) => optional(properties[key]!)))
          problems.push(`${path}: every key may be empty`);
        for (const key of keys) walk(properties[key], `${path}.${key}`);
      }
      for (const key of ["items", "anyOf"]) walk(schema[key], path);
    };
    for (const definition of PERSONAL_WIKI_NODE_TYPES.values())
      for (const existing of [true, false])
        walk(
          strictWikiPageSchema(definition, { existing }),
          `${definition.id}${existing ? "" : ".new"}`,
        );
    expect(problems).toEqual([]);
  });
});
