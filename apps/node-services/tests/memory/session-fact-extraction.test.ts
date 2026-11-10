import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { promptRoot } from "../../src/memory/paths.js";
import type { MemoryModelChainRunner } from "../../src/memory/llm.js";
import {
  extractWindowBatch,
  factBatchKey,
  factUserMessage,
  factWindows,
  FACT_WINDOW_CHARS,
  normalizeExtractedFacts,
  writtenLikeSource,
} from "../../src/memory/session-fact-extraction.js";
import { chunkSource } from "../../src/memory/search/chunks.js";
import {
  ModelCallError,
  type ModelChain,
  type ModelChainSpec,
} from "../../src/runtime-model-call.js";

const message = (at: string, text: string) => `## ${at} · Ann\n\n${text}`;

// Han is its own detected script, so this pair must be Han text; code points
// keep the source file free of Han.
const HAN_SOURCE =
  "\u5468\u4e09\u548c\u5ba2\u6237\u786e\u8ba4\u4e86\u5408\u540c\uff0c\u4e0b\u5468\u4e00\u5f00\u59cb\u90e8\u7f72\u65b0\u7684\u8bb0\u5fc6\u68c0\u7d22\u670d\u52a1\u3002";
const HAN_FACT =
  "\u4e0b\u5468\u4e00\u5f00\u59cb\u90e8\u7f72\u8bb0\u5fc6\u68c0\u7d22\u670d\u52a1";

describe("Session fact extraction", () => {
  it("uses Hindsight's concise prompt with an invented first example", async () => {
    const prompt = await fs.readFile(
      path.join(promptRoot, "facts", "fact-extraction.md"),
      "utf8",
    );
    expect(prompt).toContain(
      "Extract SIGNIFICANT facts from text. Be SELECTIVE",
    );
    expect(prompt).toContain("QUALITY OVER QUANTITY");
    // Hindsight's Example 1 overlapped a public benchmark and is replaced.
    expect(prompt).not.toMatch(/rooftop|married Sarah/u);
    expect(prompt).toContain("cello lessons");
  });

  it("groups consecutive chunks into windows of at most 3,000 characters", () => {
    const content = [1, 2, 3]
      .map((n) => message(`2026-05-24T0${n}:00:00.000Z`, `${n} `.repeat(650)))
      .join("\n\n");
    const windows = factWindows(chunkSource(content));
    expect(windows.length).toBeGreaterThan(1);
    expect(
      windows.every(
        (window) =>
          window.text.length <= FACT_WINDOW_CHARS || window.chunks.length === 1,
      ),
    ).toBe(true);
    expect(windows.flatMap((w) => w.chunks)).toHaveLength(
      chunkSource(content).length,
    );
  });

  it("builds Hindsight's user message", () => {
    expect(
      factUserMessage(
        { text: "Content here" },
        0,
        2,
        new Date("2024-03-14T09:00:00Z"),
        "Conversation session on 2024-03-14",
      ),
    ).toBe(
      "Extract facts from the following chunk.\n\nChunk: 1/2\nEvent Date: Thursday, March 14, 2024 (2024-03-14T09:00:00.000Z)\nContext: Conversation session on 2024-03-14\n\nContent:\nContent here",
    );
  });

  it("post-processes facts as Hindsight does", () => {
    const base = {
      when: "N/A",
      where: "",
      who: "user",
      why: "N/A",
      fact_type: "world",
      entities: ["user", 3, "./documents/" + "x".repeat(90) + ".html"],
    };
    expect(
      normalizeExtractedFacts({
        facts: [
          {
            ...base,
            what: "Likes tea",
            fact_kind: "conversation",
            occurred_start: "2024-01-01",
          },
          {
            ...base,
            what: "Ran a 5K",
            fact_kind: "event",
            occurred_start: "2024-03-10T08:00:00Z",
            occurred_end: null,
          },
          {
            ...base,
            what: "Moved house",
            fact_kind: "event",
            occurred_start: "2024-02-01",
            occurred_end: "2024-01-01",
          },
          { ...base, what: " ", fact_kind: "event" },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        what: "Likes tea",
        fact_kind: "conversation",
        where: "N/A",
        entities: ["user"],
      }),
      expect.objectContaining({
        what: "Ran a 5K",
        occurred_start: "2024-03-10",
        occurred_end: "2024-03-10",
      }),
      expect.objectContaining({
        what: "Moved house",
        occurred_end: "2024-02-01",
      }),
    ]);
    expect(
      normalizeExtractedFacts({
        facts: [{ ...base, what: "Likes tea", fact_kind: "conversation" }],
      })[0],
    ).not.toHaveProperty("occurred_start");
  });

  it("recognizes facts translated out of their window's language", () => {
    const english =
      "Caroline keeps volunteering at the youth center, where she built strong bonds with the kids.";
    expect(
      writtenLikeSource(
        "Caroline keeps volunteering at the youth center",
        english,
      ),
    ).toBe(true);
    expect(
      writtenLikeSource(
        "Caroline continúa haciendo voluntariado en el centro juvenil",
        english,
      ),
    ).toBe(false);
    expect(
      writtenLikeSource(
        "Caroline продолжает волонтёрство в молодёжном центре",
        english,
      ),
    ).toBe(false);
    expect(writtenLikeSource(HAN_FACT, HAN_SOURCE)).toBe(true);
    expect(
      writtenLikeSource(
        "Deployment of the memory retrieval service starts next Monday",
        HAN_SOURCE,
      ),
    ).toBe(false);
    expect(
      writtenLikeSource(
        "らいしゅうのげつようびにデプロイをかいしする",
        "らいしゅうのげつようびにデプロイをかいしします。",
      ),
    ).toBe(true);
    expect(writtenLikeSource("Likes tea", english)).toBe(true);
  });

  const fact = (what: string) => ({
    what,
    when: "N/A",
    where: "N/A",
    who: "Ann",
    why: "N/A",
    fact_kind: "conversation",
    occurred_start: null,
    occurred_end: null,
    fact_type: "world",
    entities: [],
  });
  const owner = { tenantId: "tenant_1", ownerActorId: "human_1" };
  const batchOf = (...texts: string[]) =>
    texts.map((text, index) => ({
      window: factWindows(
        chunkSource(message(`2026-05-24T0${index + 1}:00:00.000Z`, text)),
      )[0]!,
      index,
      total: texts.length,
      eventDate: undefined,
      context: "none",
    }));
  type RequestArgs = Parameters<ModelChain["call"]>[0];
  const unused = () => Promise.reject(new Error("unused chain call"));
  /** Runs the chain body against handler, recording each chain's spec. */
  const chainOf =
    (
      handler: (args: RequestArgs) => Promise<Record<string, unknown>>,
      specs: ModelChainSpec[] = [],
    ): MemoryModelChainRunner =>
    (spec, body) => {
      specs.push(spec);
      return body({
        signal: new AbortController().signal,
        call: async (args) => ({ output: await handler(args), model: "test" }),
        text: unused,
        workspace: unused,
      });
    };

  it("asks once for a window that repeats within a batch", async () => {
    const [window] = batchOf(
      "Ann volunteers at the youth center every weekend.",
    );
    const batch = [window!, { ...window!, index: 1 }];
    const requests: RequestArgs[] = [];
    const request = async (args: RequestArgs) => {
      requests.push(args);
      return {
        windows: [
          {
            window_sha256: window!.window.sha256,
            facts: [fact("Ann volunteers")],
          },
        ],
      };
    };
    const facts = await extractWindowBatch(batch, owner, chainOf(request));
    const schema = requests[0]!.outputSchema as {
      properties: {
        windows: {
          maxItems: number;
          items: { properties: { window_sha256: { enum: string[] } } };
        };
      };
    };
    expect(schema.properties.windows.maxItems).toBe(1);
    expect(
      schema.properties.windows.items.properties.window_sha256.enum,
    ).toEqual([window!.window.sha256]);
    expect(
      requests[0]!.input.split(
        `=== window_sha256: ${window!.window.sha256} ===`,
      ),
    ).toHaveLength(2);
    expect(facts.get(window!.window.sha256)?.map(({ what }) => what)).toEqual([
      "Ann volunteers",
    ]);
  });

  it("extracts a batch of windows in one call keyed by window_sha256", async () => {
    const batch = batchOf(
      "Ann volunteers at the youth center every weekend.",
      "Ann adopted a Golden Retriever named Max.",
      "Ann plans a trip to Kyoto in April.",
    );
    const requests: RequestArgs[] = [];
    const request = async (args: RequestArgs) => {
      requests.push(args);
      return {
        windows: [
          {
            window_sha256: batch[1]!.window.sha256,
            facts: [fact("Ann adopted Max")],
          },
          {
            window_sha256: batch[0]!.window.sha256,
            facts: [fact("Ann volunteers")],
          },
          { window_sha256: "unknown", facts: [fact("Invented")] },
        ],
      };
    };
    const specs: ModelChainSpec[] = [];
    const facts = await extractWindowBatch(
      batch,
      owner,
      chainOf(request, specs),
    );
    // One chain per batch, named by its windows in any order.
    expect(specs).toEqual([
      { kind: "memory", owner, key: factBatchKey(batch) },
    ]);
    expect(factBatchKey([...batch].reverse())).toBe(factBatchKey(batch));
    expect(factBatchKey(batch)).toMatch(/^memory\.facts:[a-f0-9]{64}$/u);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      step: "first",
      schemaName: "fact_extraction",
      effort: "low",
    });
    for (const item of batch)
      expect(requests[0]!.input).toContain(
        `=== window_sha256: ${item.window.sha256} ===`,
      );
    const schema = requests[0]!.outputSchema as {
      properties: {
        windows: {
          maxItems: number;
          items: { properties: { window_sha256: { enum: string[] } } };
        };
      };
    };
    expect(schema.properties.windows.maxItems).toBe(3);
    expect(
      schema.properties.windows.items.properties.window_sha256.enum,
    ).toEqual(batch.map((item) => item.window.sha256));
    expect(facts.get(batch[0]!.window.sha256)?.map(({ what }) => what)).toEqual(
      ["Ann volunteers"],
    );
    expect(facts.get(batch[1]!.window.sha256)?.map(({ what }) => what)).toEqual(
      ["Ann adopted Max"],
    );
    // A window the answer left out is extracted again by the next sync.
    expect(facts.has(batch[2]!.window.sha256)).toBe(false);
  });

  it("extracts drifted windows once more together and drops facts still translated", async () => {
    const batch = batchOf(
      "Ann volunteers at the youth center every weekend.",
      "Ann adopted a Golden Retriever named Max.",
    );
    const [drifting, steady] = batch.map((item) => item.window.sha256);
    const responses = [
      [
        {
          window_sha256: drifting,
          facts: [
            fact("Ann volunteers at the youth center every weekend"),
            fact("Ann es voluntaria en el centro juvenil cada fin de semana"),
          ],
        },
        {
          window_sha256: steady,
          facts: [fact("Ann adopted a Golden Retriever named Max")],
        },
      ],
      [
        {
          window_sha256: drifting,
          facts: [
            fact("Ann volunteers at the youth center every weekend"),
            fact(
              "Ann ist jedes Wochenende ehrenamtlich im Jugendzentrum tätig",
            ),
          ],
        },
      ],
    ];
    const users: string[] = [];
    const steps: string[] = [];
    const request = async ({ input: user, step }: RequestArgs) => {
      users.push(user);
      steps.push(step);
      return { windows: responses[users.length - 1] };
    };
    const facts = await extractWindowBatch(batch, owner, chainOf(request));
    expect(users).toHaveLength(2);
    expect(steps).toEqual(["first", "first-drift"]);
    expect(users[1]).toContain(drifting);
    expect(users[1]).not.toContain(steady);
    expect(facts.get(drifting!)?.map(({ what }) => what)).toEqual([
      "Ann volunteers at the youth center every weekend",
    ]);
    expect(facts.get(steady!)).toHaveLength(1);
  });

  it("retries a batch whose answer stays invalid as two halves", async () => {
    const batch = batchOf("part 1", "part 2");
    const calls: string[] = [];
    const steps: string[] = [];
    let running = 0;
    let mostRunning = 0;
    const request = async ({ input: user, step }: RequestArgs) => {
      calls.push(user);
      steps.push(step);
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      if (user.includes("part 1") && user.includes("part 2"))
        throw new ModelCallError("invalid_output", "not valid JSON");
      const item = batch.find(({ window }) => user.includes(window.sha256))!;
      return {
        windows: [
          {
            window_sha256: item.window.sha256,
            facts: [fact(user.includes("part 1") ? "First" : "Second")],
          },
        ],
      };
    };
    const facts = await extractWindowBatch(batch, owner, chainOf(request));
    expect(
      [...facts.values()]
        .flat()
        .map(({ what }) => what)
        .sort(),
    ).toEqual(["First", "Second"]);
    expect(calls).toHaveLength(3);
    // The halves are steps of the same chain, not chains of their own, and the
    // chain runs them one after the other.
    expect(steps).toEqual(["first", "split-0", "split-1"]);
    expect(mostRunning).toBe(1);
  });

  it("lets an offline Computer fail the batch so every window waits", async () => {
    const offline = new ModelCallError("computer_offline", "offline");
    await expect(
      extractWindowBatch(
        batchOf("part 1", "part 2"),
        owner,
        chainOf(async () => {
          throw offline;
        }),
      ),
    ).rejects.toBe(offline);
  });
});
