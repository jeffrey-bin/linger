import { describe, expect, it } from "vitest";

import {
  decodeExecutionContextKey,
  encodeExecutionContextRef,
} from "../../../src/agent/executor/context-ref.js";

describe("ExecutionContextRef", () => {
  it("uses one canonical key for Meta, alterEgo, and Document identities", () => {
    const meta = {
      kind: "meta",
      agentId: "agent-1",
      roomId: "room-7",
    } as const;
    const alterEgo = {
      kind: "alter_ego",
      agentId: "agent-1",
      taskId: "task-42",
    } as const;
    const document = {
      kind: "document",
      agentId: "agent-1",
      documentId: "document-9",
    } as const;

    expect(encodeExecutionContextRef(meta)).toBe(
      '["meta","agent-1","room","room-7"]',
    );
    expect(encodeExecutionContextRef(alterEgo)).toBe(
      '["alter_ego","agent-1","task-42"]',
    );
    expect(encodeExecutionContextRef(document)).toBe(
      '["document","agent-1","document-9"]',
    );
    expect(decodeExecutionContextKey(encodeExecutionContextRef(meta))).toEqual(
      meta,
    );
    expect(
      decodeExecutionContextKey(encodeExecutionContextRef(alterEgo)),
    ).toEqual(alterEgo);
    expect(
      decodeExecutionContextKey(encodeExecutionContextRef(document)),
    ).toEqual(document);
  });

  it("rejects non-canonical encodings and fake identity fields", () => {
    expect(() =>
      decodeExecutionContextKey('[ "meta", "agent-1", "room", "room-1" ]'),
    ).toThrow("not canonical");
    expect(() => decodeExecutionContextKey('["meta","agent-1"]')).toThrow(
      "unsupported shape",
    );
    expect(() => decodeExecutionContextKey('["meta","agent-1",null]')).toThrow(
      "unsupported shape",
    );
    expect(() =>
      decodeExecutionContextKey('["meta","agent-1","room",""]'),
    ).toThrow("roomId must be a non-empty string");
    expect(() =>
      decodeExecutionContextKey('["meta","agent-1","rooms","room-1"]'),
    ).toThrow("unsupported shape");
    expect(() =>
      decodeExecutionContextKey('["alter_ego","agent-1",""]'),
    ).toThrow("taskId must be a non-empty string");
    expect(() =>
      decodeExecutionContextKey('["document","agent-1",""]'),
    ).toThrow("documentId must be a non-empty string");
  });
});
