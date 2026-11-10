import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readEntityIndex,
  renderEntityRegistry,
} from "../../src/llm-wiki/wiki-entity-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function wiki(pages: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "llm-wiki-registry-"));
  roots.push(root);
  for (const [path, content] of Object.entries(pages)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe("existing-entity registry", () => {
  it("lists every durable entity with name, aliases, parts and last update", async () => {
    const root = await wiki({
      "projects/atlas.md": `---
type: Project
project_name: Atlas
aliases: [Atlas App, Атлас]
description: A planning product and its rollout.
---
# Atlas

## Project Directions

##### Direction: Search

Current state.

##### Direction: Evaluation

Current state.

## Change Log

- 2026-07-01: Created.
- 2026-09-08: Added search evidence.
`,
      "projects/index.md": "# Projects\n",
      "topics/retrieval.md": `---
type: Topic
topic_name: Retrieval
---
# Retrieval

## Change Log

None observed.
`,
      "sessions/2026-09-08/room.md": "---\ntype: Session\n---\n# Session\n",
    });

    const registry = renderEntityRegistry(await readEntityIndex(root));

    expect(registry).toContain(
      "- projects/atlas.md | Atlas | aliases: Atlas App; Атлас | parts: Search; Evaluation | updated: 2026-09-08 | A planning product and its rollout.",
    );
    expect(registry).toContain(
      "- topics/retrieval.md | Retrieval | aliases: none | parts: none | updated: unknown",
    );
    expect(registry).toContain("## clients/ (client)\n- none");
    expect(registry).not.toContain("index.md");
    expect(registry).not.toContain("sessions/");
  });
});
