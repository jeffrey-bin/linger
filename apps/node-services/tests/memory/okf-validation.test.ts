import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyMemoryUpdate,
  validateMemoryUpdate,
} from "../../src/memory/apply.js";
import {
  assertValidMemoryMarkdown,
  inspectMemoryMarkdown,
} from "../../src/memory/okf-validation.js";

describe("assertValidMemoryMarkdown", () => {
  it("reports every invalid file before writing any part of a batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-all-errors-"));
    try {
      const output = {
        schema_version: 1 as const,
        date: "2026-09-08",
        memory_log_entries: [],
        files: [
          {
            path: "agent_1/me/profile.md",
            content: "---\ntype: User Profile\nstatus: active\n---\n",
          },
          {
            path: "agent_1/knowledge/projects/example.md",
            content: "---\ntype: Project Memory\n title: Invalid\n---\n",
          },
        ],
      };
      let error: unknown;
      try {
        await validateMemoryUpdate(root, output);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as Error).message).toContain("me/profile.md");
      expect((error as Error).message).toContain(
        "knowledge/projects/example.md",
      );
      await expect(applyMemoryUpdate(root, output)).rejects.toThrow(
        "invalid_yaml",
      );
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("keeps apply-time OKF status closed independently of graph indexing", () => {
    const content = `---
type: Project Memory
status: active
project_name: Inbound
project_slug: inbound
memory_subject_key: agent_1
stale_after: null
---
`;
    expect(() =>
      assertValidMemoryMarkdown("knowledge/projects/inbound.md", content),
    ).toThrow(/invalid_status.*invalid_stale_after/u);
    const inspected = inspectMemoryMarkdown(
      "knowledge/projects/inbound.md",
      content,
    );
    expect(inspected.issues.map(({ code }) => code).sort()).toEqual([
      "invalid_stale_after",
      "invalid_status",
    ]);
  });

  it("accepts OKF lifecycle fields plus Memory extension status", () => {
    expect(() =>
      assertValidMemoryMarkdown(
        "knowledge/projects/delivery.md",
        `---
type: Project Memory
status: stable
project_status: active
project_name: Delivery
project_slug: delivery
memory_subject_key: agent_1
---
`,
      ),
    ).not.toThrow();
  });

  it("normalizes common generated frontmatter quote mistakes before writing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-okf-repair-"));
    const subjectKey = "agent_1";
    await applyMemoryUpdate(root, {
      schema_version: 1,
      date: "2026-09-08",
      files: [
        {
          path: `${subjectKey}/knowledge/projects/delivery.md`,
          content: `---
type: Project Memory
title: Project: Delivery"
status: stable
project_name: Delivery
project_slug: delivery
memory_subject_key: ${subjectKey}
sources:
  - title: Session: 2026-09-08 planning
    resource: memory://session/1
---

# Project: Delivery
`,
        },
      ],
      memory_log_entries: [],
    });

    const stored = await fs.readFile(
      path.join(
        root,
        subjectKey,
        "memory",
        "knowledge",
        "projects",
        "delivery.md",
      ),
      "utf8",
    );
    expect(stored).toContain('title: "Project: Delivery"');
    expect(stored).toContain('  - title: "Session: 2026-09-08 planning"');
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects non-OKF status and missing path-required metadata", () => {
    expect(() =>
      assertValidMemoryMarkdown(
        "timeline/daily/2026-09-08.md",
        "---\ntype: Daily Memory\nstatus: active\n---\n",
      ),
    ).toThrow(/invalid_status.*missing_memory_metadata/u);
  });

  it("requires session identity metadata", () => {
    expect(() =>
      assertValidMemoryMarkdown(
        "evidence/2026-09-08/sessions/room_1.md",
        "---\ntype: Session Memory\nstatus: stable\n---\n",
      ),
    ).toThrow(/date.*room_id.*memory_subject_key/u);
  });

  it("rejects legacy session lifecycle values in status on write", () => {
    expect(() =>
      assertValidMemoryMarkdown(
        "evidence/2026-09-11/sessions/room_1.md",
        `---
type: Session Memory
date: 2026-09-11
room_id: room_1
memory_subject_key: agent_1
status: summarized
---
`,
      ),
    ).toThrow(/invalid_status/u);
  });

  it("rejects an invalid batch before writing any file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-okf-batch-"));
    const subjectKey = "agent_1";
    await expect(
      applyMemoryUpdate(root, {
        schema_version: 1,
        date: "2026-09-08",
        files: [
          {
            path: `${subjectKey}/me/profile.md`,
            content: "---\ntype: User Profile\nstatus: stable\n---\n",
          },
          {
            path: `${subjectKey}/knowledge/projects/delivery.md`,
            content: "---\ntype: Project Memory\nstatus: active\n---\n",
          },
        ],
        memory_log_entries: [],
      }),
    ).rejects.toThrow("Invalid OKF memory document");
    await expect(
      fs.access(path.join(root, subjectKey, "memory", "me", "profile.md")),
    ).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects conflicting mutations before writing any file", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "memory-conflict-batch-"),
    );
    const subjectKey = "agent_1";
    const outputPath = `${subjectKey}/knowledge/projects/delivery.md`;
    await expect(
      applyMemoryUpdate(root, {
        schema_version: 1,
        date: "2026-09-08",
        files: [
          {
            path: outputPath,
            content: `---
type: Project Memory
status: stable
project_name: Delivery
project_slug: delivery
memory_subject_key: ${subjectKey}
---

# Project: Delivery
`,
          },
        ],
        deleted_paths: [outputPath],
        memory_log_entries: [],
      }),
    ).rejects.toThrow("Memory output cannot write and delete the same path");
    await expect(
      fs.access(
        path.join(
          root,
          subjectKey,
          "memory",
          "knowledge",
          "projects",
          "delivery.md",
        ),
      ),
    ).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});
