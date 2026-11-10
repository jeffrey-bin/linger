import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const documentRoot = fileURLToPath(
  new URL("../../src/document/", import.meta.url),
);
const WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?!\(|\$\{|SET\b)([A-Za-z_][\w.]*)/g;
const READ =
  /\b(?:FROM|JOIN(?:\s+LATERAL\b)?)\s+(?!\(|\$\{|LATERAL\b)([A-Za-z_][\w.]*)/g;
// The only TeamHub function the Runtime calls: it copies the body row into a
// Revision for an idle or continuous-editing History point.
const FUNCTION = /\b([a-z_]*document[a-z_]*)\(/g;
// Table names a statement may name after FROM without reading a table.
const NOT_TABLES = new Set([
  "unnest",
  "jsonb_array_elements",
  "jsonb_to_recordset",
]);
const READABLE = new Set([
  "documents",
  "document_permission_counts",
  "document_bodies",
  "document_assets",
  "document_revisions",
  "room_document_comment_threads",
]);

describe("Document Runtime database boundary", () => {
  it("writes only document_bodies in TeamHub's database", async () => {
    const writes = new Set<string>();
    for (const { source } of await sqlSources())
      for (const match of source.matchAll(WRITE)) writes.add(match[1]!);
    expect([...writes]).toEqual(["document_bodies"]);
  });

  it("records History points only through record_document_history_point", async () => {
    const functions = new Set<string>();
    for (const { source } of await sqlSources())
      for (const match of source.matchAll(FUNCTION)) functions.add(match[1]!);
    expect([...functions]).toEqual(["record_document_history_point"]);
  });

  it("reads only the Document, permission count, body, Revision, Asset and Comment Thread tables", async () => {
    const violations: string[] = [];
    for (const { file, source } of await sqlSources())
      for (const match of source.matchAll(READ)) {
        const name = match[1]!;
        if (!READABLE.has(name) && !NOT_TABLES.has(name))
          violations.push(`${file}: ${match[0]}`);
      }
    expect(violations).toEqual([]);
  });

  it("opens the database only through the body store", async () => {
    const pools: string[] = [];
    for (const file of await typeScriptFiles(documentRoot))
      if (/from "postgres";$/mu.test(await fs.readFile(file, "utf8")))
        pools.push(path.relative(documentRoot, file));
    expect(pools).toEqual(["bodies.ts"]);
  });
});

// The SQL tagged templates of the role's sources: postgres.js statements are
// the only text that starts with sql`.
async function sqlSources(): Promise<Array<{ file: string; source: string }>> {
  const sources: Array<{ file: string; source: string }> = [];
  for (const file of await typeScriptFiles(documentRoot)) {
    const text = await fs.readFile(file, "utf8");
    for (const match of text.matchAll(/sql(?:<[\s\S]*?>)?`([\s\S]*?)`/g))
      sources.push({
        file: path.relative(documentRoot, file),
        source: match[1]!,
      });
  }
  return sources;
}

async function typeScriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}
