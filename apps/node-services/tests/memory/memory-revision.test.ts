import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyMemoryUpdate } from "../../src/memory/apply.js";
import {
  MEMORY_REVISION_FILE,
  markMemoryChanged,
} from "../../src/memory/fs-utils.js";

const roots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-revision-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe("markMemoryChanged", () => {
  it("replaces the marker beside memory/ with a new private token", async () => {
    const root = await tempRoot();
    const marker = path.join(root, "agent_1", MEMORY_REVISION_FILE);

    await markMemoryChanged(root, "agent_1");
    const first = await fs.readFile(marker, "utf8");
    await markMemoryChanged(root, "agent_1");
    const second = await fs.readFile(marker, "utf8");

    expect(second).not.toBe(first);
    expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
    // Atomic replacement leaves no temporary file behind.
    expect(await fs.readdir(path.join(root, "agent_1"))).toEqual([
      MEMORY_REVISION_FILE,
    ]);
  });

  it("is bumped after applyMemoryUpdate writes memory files", async () => {
    const root = await tempRoot();
    const marker = path.join(root, "agent_1", MEMORY_REVISION_FILE);
    await markMemoryChanged(root, "agent_1");
    const before = await fs.readFile(marker, "utf8");

    await applyMemoryUpdate(root, {
      schema_version: 1,
      date: "2026-10-23",
      files: [
        {
          path: "agent_1/knowledge/projects/delivery.md",
          content: `---
type: Project Memory
title: Delivery
status: stable
project_name: Delivery
project_slug: delivery
memory_subject_key: agent_1
---

# Delivery
`,
        },
      ],
      memory_log_entries: [
        {
          memory_path: "agent_1/knowledge/projects/delivery.md",
          reason: "New delivery project.",
        },
      ],
    });

    const written = path.join(
      root,
      "agent_1",
      "memory",
      "knowledge",
      "projects",
      "delivery.md",
    );
    expect(await fs.readFile(written, "utf8")).toContain("# Delivery");
    expect(await fs.readFile(marker, "utf8")).not.toBe(before);
    // Apply keeps no update logs beside the memory files.
    expect(await fs.readdir(path.join(root, "agent_1", "memory"))).toEqual([
      "knowledge",
    ]);
  });
});
