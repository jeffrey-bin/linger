import { describe, expect, it } from "vitest";
import { validateMemoryUpdate } from "../../src/memory/apply.js";
import { memoryOutputPrefixes } from "../../src/memory/sync-policy.js";

const subject = "agent_policy_test";

describe("summary filesystem boundary", () => {
  it.each(["daily", "weekly"] as const)(
    "rejects %s deletions and another subject's writes",
    async (task) => {
      const prefix = memoryOutputPrefixes(task, "write")[0]!;
      const options = {
        allowedSubjectKeys: [subject],
        allowedPathPrefixes: memoryOutputPrefixes(task, "write"),
        allowedDeletePathPrefixes: memoryOutputPrefixes(task, "delete"),
      };
      const output = {
        schema_version: 1 as const,
        date: "2026-09-11",
        files: [],
        deleted_paths: [`${subject}/${prefix}2026-09-11.md`],
        memory_log_entries: [],
      };
      await expect(
        validateMemoryUpdate("/tmp/memory-policy-test", output, options),
      ).rejects.toThrow("outside the allowed scope");
      await expect(
        validateMemoryUpdate(
          "/tmp/memory-policy-test",
          {
            ...output,
            deleted_paths: [],
            files: [
              {
                path: `another_subject/${prefix}2026-09-11.md`,
                content: "# Wrong subject",
              },
            ],
          },
          options,
        ),
      ).rejects.toThrow("subject");
    },
  );
});
