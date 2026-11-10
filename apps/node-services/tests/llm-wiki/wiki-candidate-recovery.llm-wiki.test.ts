import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { parseOkfFrontmatter } from "@linger/knowledge-format";
import { recoverOptionalWikiPages } from "../../src/llm-wiki/wiki-candidate-recovery.js";

describe("safe candidate degradation", () => {
  it("restores optional old pages and drops invalid new pages without touching a required target", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-recovery-"));
    try {
      const baseline = join(root, "baseline");
      const candidate = join(root, "candidate");
      await mkdir(join(baseline, "topics"), { recursive: true });
      await mkdir(join(candidate, "topics"), { recursive: true });
      await writeFile(join(baseline, "topics/old.md"), "trusted bytes");
      await writeFile(join(candidate, "topics/old.md"), "invalid");
      await writeFile(join(candidate, "topics/new.md"), "invalid");
      const input = {
        directory: candidate,
        baselineDirectory: baseline,
        baseline: new Map([["topics/old.md", "hash"]]),
        requiredTargets: ["sessions/2026-09-29/a.md"],
      };
      expect(
        await recoverOptionalWikiPages({
          ...input,
          issues: [
            {
              code: "invalid_evidence_reference",
              page: "topics/old.md",
              detail: "bad",
            },
            { code: "invalid_okf", page: "topics/new.md", detail: "bad" },
          ],
        }),
      ).toEqual({ restored: ["topics/old.md"], omitted: ["topics/new.md"] });
      expect(await readFile(join(candidate, "topics/old.md"), "utf8")).toBe(
        "trusted bytes",
      );
      await expect(access(join(candidate, "topics/new.md"))).rejects.toThrow();
      expect(
        await recoverOptionalWikiPages({
          ...input,
          issues: [
            {
              code: "missing_target_page",
              page: input.requiredTargets[0],
              detail: "missing",
            },
          ],
        }),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("removes references to an omitted optional page without rewriting unrelated pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "wiki-reference-recovery-"));
    try {
      const baseline = join(root, "baseline");
      const candidate = join(root, "candidate");
      await mkdir(join(baseline, "topics"), { recursive: true });
      await mkdir(join(candidate, "sessions/2026-09-29"), { recursive: true });
      await mkdir(join(candidate, "topics"), { recursive: true });
      const required = "sessions/2026-09-29/room_a.md";
      const unrelated =
        "---\ntype: Topic\nrelations: {}\n---\n# Keep exact bytes\n";
      await writeFile(
        join(candidate, required),
        `---\n${JSON.stringify(
          {
            type: "Session",
            relations: { topics: ["optional"], clients: ["kept"] },
          },
          null,
          2,
        )}\n---\n# Session\n\nSee [Optional topic](../../topics/optional.md) and [Kept client](../../clients/kept.md).\n`,
      );
      await writeFile(
        join(candidate, "index.md"),
        "# Wiki\n\n- [Optional](topics/optional.md)\n- [Kept](topics/kept.md)\n",
      );
      await writeFile(join(candidate, "topics/optional.md"), "invalid");
      await writeFile(join(candidate, "topics/unrelated.md"), unrelated);
      const result = await recoverOptionalWikiPages({
        directory: candidate,
        baselineDirectory: baseline,
        baseline: new Map(),
        requiredTargets: [required],
        issues: [
          {
            code: "placeholder_content",
            page: "topics/optional.md",
            detail: "bad optional page",
          },
        ],
      });
      expect(result).toEqual({
        restored: [],
        omitted: ["topics/optional.md"],
      });
      const session = await readFile(join(candidate, required), "utf8");
      expect(session).toContain("See Optional topic and [Kept client]");
      expect(session).not.toContain("topics/optional.md");
      expect(parseOkfFrontmatter(session).fields?.relations).toEqual({
        topics: [],
        clients: ["kept"],
      });
      const index = await readFile(join(candidate, "index.md"), "utf8");
      expect(index).not.toContain("topics/optional.md");
      expect(index).toContain("topics/kept.md");
      expect(
        await readFile(join(candidate, "topics/unrelated.md"), "utf8"),
      ).toBe(unrelated);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
