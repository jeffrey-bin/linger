import { describe, expect, it } from "vitest";

import { parseMemoryUpdateOutput } from "../../src/memory/apply.js";

const subject = "agent_5f85f4dfa28c0c66c29addd6c20f5a8e";
const other = "agent_bob";
const projectPath = `${subject}/knowledge/projects/new-project.md`;

function output() {
  return {
    schema_version: 1,
    date: "2026-08-25",
    files: [{ path: projectPath, content: "# Project\n" }],
    deleted_paths: [] as string[],
    memory_log_entries: [
      { memory_subject_key: subject, memory_path: projectPath },
    ],
  };
}

describe("Memory output subject scope", () => {
  it.each([subject.slice(0, -1), other])(
    "rejects an incorrect write subject %s before task validation",
    (incorrect) => {
      const candidate = output();
      candidate.files[0]!.path = `${incorrect}/knowledge/projects/new-project.md`;
      expect(() =>
        parseMemoryUpdateOutput(JSON.stringify(candidate), [subject]),
      ).toThrow(`Expected subject: ${subject}`);
      expect(candidate.files[0]!.path).toContain(incorrect);
    },
  );

  it.each(["delete", "log_path", "log_subject"])(
    "rejects a foreign %s even when file paths are valid",
    (field) => {
      const candidate = output();
      if (field === "delete")
        candidate.deleted_paths = [`${other}/me/memory.md`];
      if (field === "log_path")
        candidate.memory_log_entries[0]!.memory_path = `${other}/me/memory.md`;
      if (field === "log_subject")
        candidate.memory_log_entries[0]!.memory_subject_key = other;
      expect(() =>
        parseMemoryUpdateOutput(JSON.stringify(candidate), [subject]),
      ).toThrow();
    },
  );

  it("accepts valid multi-subject outputs and unscoped parsing", () => {
    const candidate = output();
    candidate.files.push({
      path: `${other}/knowledge/clients/new-client.md`,
      content: "# Client\n",
    });
    expect(
      parseMemoryUpdateOutput(JSON.stringify(candidate), [subject, other])
        .files,
    ).toHaveLength(2);
    expect(
      parseMemoryUpdateOutput(JSON.stringify(candidate)).files,
    ).toHaveLength(2);
  });
});
