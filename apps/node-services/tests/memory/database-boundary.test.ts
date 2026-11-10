import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const memoryRoot = fileURLToPath(new URL("../../src/memory/", import.meta.url));
/** Relations a statement reads or writes; `${...}` and `(...)` are subqueries. */
const RELATION =
  /(?<!DISTINCT\s+)\b(?:FROM|JOIN(?:\s+LATERAL)?|INSERT\s+INTO|UPDATE)\s+(?!\(|\$\{|SET\b|SKIP\b)([A-Za-z_][\w.]*)/g;
const CTE = /\b([A-Za-z_]\w*)\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/g;
const BUILTINS = new Set(["unnest"]);

describe("Memory database boundary", () => {
  it("references only memory_index and memory_source in TeamHub's database", async () => {
    const violations: string[] = [];
    for (const file of await typeScriptFiles(memoryRoot)) {
      const source = await fs.readFile(file, "utf8");
      const ctes = new Set([...source.matchAll(CTE)].map((match) => match[1]));
      for (const match of source.matchAll(RELATION)) {
        const name = match[1]!;
        if (
          /^memory_(?:index|source)\.\w+$/.test(name) ||
          ctes.has(name) ||
          BUILTINS.has(name)
        )
          continue;
        violations.push(`${path.relative(memoryRoot, file)}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("opens the database only through Memory's one pool", async () => {
    const pools: string[] = [];
    for (const file of await typeScriptFiles(memoryRoot))
      if (
        /^import postgres from "postgres";$/mu.test(
          await fs.readFile(file, "utf8"),
        )
      )
        pools.push(path.relative(memoryRoot, file));
    expect(pools).toEqual(["database.ts"]);
  });
});

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}
