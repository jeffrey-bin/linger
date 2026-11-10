import { describe, expect, it, vi } from "vitest";

import { createRuntimeQuestion } from "../../../src/agent/executor/local-backend.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";

const body = {
  context_key: "context-1",
  execution_run_ref: "run-1",
  operation_id: "operation-1",
  request: { request_id: "question-1", kind: "native_question" },
};

const ask = (
  fetch: typeof globalThis.fetch,
  signal = new AbortController().signal,
) => {
  const log = vi.fn();
  const logger: AgentLogger = { log, child: () => logger };
  const result = createRuntimeQuestion(
    { baseUrl: "http://teamhub.test", serviceToken: "token", fetch },
    body,
    signal,
    logger,
  );
  return { result, log };
};

const answer = (status: number, payload: unknown) =>
  vi.fn(async () => Response.json(payload, { status }));

describe("createRuntimeQuestion", () => {
  it("returns TeamHub's pending receipt", async () => {
    const fetch = answer(201, {
      interaction_id: "interaction-1",
      message_id: "message-1",
      status: "pending",
    });
    const { result, log } = ask(fetch);
    await expect(result).resolves.toEqual({
      interaction_id: "interaction-1",
      message_id: "message-1",
      status: "pending",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [
      400,
      "INVALID_REQUEST",
      "assignee_actor_id must name a human member of this Room",
      "refused",
      "The question was not posted (TeamHub answered 400 INVALID_REQUEST: assignee_actor_id must name a human member of this Room). Correct the input and ask again.",
    ],
    [
      409,
      "CONFLICT",
      "Runtime request no longer belongs to an active execution",
      "refused",
      "This Run can no longer ask questions; do not post it again.",
    ],
    [
      503,
      "DEPENDENCY_UNAVAILABLE",
      "Runtime interaction is temporarily unavailable",
      "unknown",
      "The question may not have been posted (TeamHub answered 503 DEPENDENCY_UNAVAILABLE",
    ],
  ])(
    "tells the model what TeamHub's %i means",
    async (status, code, message, outcome, expected) => {
      const { result, log } = ask(
        answer(status, { error: { code, message, request_id: "req-1" } }),
      );
      await expect(result).rejects.toThrow(expected);
      expect(log).toHaveBeenCalledWith(
        "warn",
        "runtime_question.create_failed",
        {
          execution_run_ref: "run-1",
          operation_id: "operation-1",
          request_id: "question-1",
          outcome,
          status,
          code,
        },
      );
    },
  );

  it("treats a lost connection as an unknown outcome", async () => {
    const { result, log } = ask(
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(result).rejects.toThrow(
      "the card may already be in the Room. Check the Room before asking again",
    );
    expect(log).toHaveBeenCalledWith(
      "warn",
      "runtime_question.create_failed",
      expect.objectContaining({ outcome: "unknown", error: "fetch failed" }),
    );
  });

  it("lets an ending Run's abort pass through", async () => {
    const controller = new AbortController();
    const aborted = new Error("Run cancelled");
    const { result, log } = ask(
      vi.fn(async () => {
        controller.abort();
        throw aborted;
      }),
      controller.signal,
    );
    await expect(result).rejects.toBe(aborted);
    expect(log).not.toHaveBeenCalled();
  });
});
