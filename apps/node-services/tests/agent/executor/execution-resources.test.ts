import { describe, expect, it } from "vitest";
import {
  parseExecutionResources,
  readRuntimeSessionCheckpoint,
} from "../../../src/agent/executor/context-runtime-state.js";

const resources = () => ({
  version: 1 as const,
  effectiveSha256: "a".repeat(64),
  skills: [
    {
      skillId: "skill-a",
      manifestId: "manifest-a",
      manifestVersion: "1.0.0+build",
      name: "Test Skill",
      packageName: "test-skill",
      packageSha256: "b".repeat(64),
      config: { nested: { language: "zh" } },
      source: "explicit" as const,
    },
  ],
});

describe("execution resources checkpoint", () => {
  it("rejects a pinned profile", () => {
    expect(() =>
      parseExecutionResources({
        ...resources(),
        userProfile: { revisionId: "profile_7", markdown: "body" },
      }),
    ).toThrow("execution");
  });
  it("freezes an independent exact descriptor without runtime authorization", () => {
    const input = resources();
    const captured = parseExecutionResources(input);
    input.skills[0]!.config.nested.language = "en";
    input.skills[0]!.manifestVersion = "2.0.0";
    expect(captured.skills[0]).toMatchObject({
      manifestVersion: "1.0.0+build",
      config: { nested: { language: "zh" } },
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.skills[0]!.config)).toBe(true);
  });

  it.each([
    [
      "unknown snapshot",
      (input: Record<string, unknown>) => {
        input.snapshotId = "snapshot-old";
      },
    ],
    [
      "Run reference",
      (input: Record<string, unknown>) => {
        input.executionRunRef = "run-exact";
      },
    ],
    [
      "unverified digest",
      (input: Record<string, unknown>) => {
        input.effectiveSha256 = "latest";
      },
    ],
    [
      "unknown version",
      (input: Record<string, unknown>) => {
        input.version = 2;
      },
    ],
  ])("rejects %s metadata", (_label, mutate) => {
    const input = resources();
    mutate(input);
    expect(() => parseExecutionResources(input)).toThrow();
  });

  it.each([
    [
      "credential",
      { config: { nested: { token: `cli_ctx_${"x".repeat(43)}` } } },
    ],
    ["headers", { config: { http_headers: {} } }],
    ["extra descriptor field", { snapshotId: "old" }],
    ["missing exact version", { manifestId: undefined }],
    ["invalid package digest", { packageSha256: "A".repeat(64) }],
    ["non-JSON config", { config: { value: undefined } }],
  ])("rejects a Skill with %s", (_label, patch) => {
    const input = resources();
    expect(() =>
      parseExecutionResources({
        ...input,
        skills: [{ ...input.skills[0], ...patch }],
      }),
    ).toThrow();
  });

  it.each(["skillId", "manifestId", "packageName"] as const)(
    "rejects duplicate %s identities",
    (field) => {
      const input = resources();
      const second = {
        ...input.skills[0]!,
        skillId: "skill-b",
        manifestId: "manifest-b",
        packageName: "other-skill",
      };
      second[field] = input.skills[0]![field];
      expect(() =>
        parseExecutionResources({
          ...input,
          skills: [...input.skills, second],
        }),
      ).toThrow("Duplicate");
    },
  );

  it("unwraps schema 1 and schema 2 without passing resource metadata to a Provider", () => {
    const nativeSession = { threadId: "thread-a", nativeCheckpoint: null };
    expect(
      readRuntimeSessionCheckpoint({
        schema_version: "1",
        session: nativeSession,
      }),
    ).toEqual({ nativeSession, executionResources: null });
    expect(
      readRuntimeSessionCheckpoint({
        schema_version: "2",
        thread_id: "thread-a",
        session: { nativeSession, executionResources: resources() },
      }),
    ).toEqual({ nativeSession, executionResources: resources() });
    expect(
      readRuntimeSessionCheckpoint({
        schema_version: "2",
        session: { nativeSession: null, executionResources: resources() },
      }),
    ).toEqual({ nativeSession: null, executionResources: resources() });
  });

  it.each([
    { schema_version: "3", session: {} },
    {
      schema_version: "2",
      thread_id: "indexed",
      session: { nativeSession: null, executionResources: resources() },
    },
    {
      schema_version: "2",
      thread_id: "indexed",
      session: {
        nativeSession: { threadId: "different" },
        executionResources: resources(),
      },
    },
    {
      schema_version: "2",
      thread_id: "indexed",
      session: { nativeSession: {}, executionResources: resources() },
    },
    { schema_version: "2", session: { nativeSession: null } },
    {
      schema_version: "2",
      session: {
        nativeSession: null,
        executionResources: resources(),
        extra: true,
      },
    },
  ])("rejects malformed envelopes %#", (checkpoint) => {
    expect(() => readRuntimeSessionCheckpoint(checkpoint)).toThrow();
  });
});
