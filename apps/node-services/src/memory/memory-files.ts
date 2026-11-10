import fs from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "./fs-utils.js";
import type { CliOptions } from "./options.js";
import { logicalMemoryPath, memoryFilePath } from "./paths.js";
import type { ExistingMemoryFile } from "./types.js";

export async function readMemoryMarkdown(
  options: Pick<CliOptions, "memoryRoot"> & { memorySubjectKey: string },
  ...segments: string[]
): Promise<ExistingMemoryFile[]> {
  const files: ExistingMemoryFile[] = [];
  for await (const file of walkFiles(
    memoryFilePath(options.memoryRoot, options.memorySubjectKey, ...segments),
  )) {
    if (!file.endsWith(".md") || path.basename(file) === "index.md") continue;
    files.push({
      path: logicalMemoryPath(
        options.memoryRoot,
        options.memorySubjectKey,
        file,
      ),
      content: await fs.readFile(file, "utf8"),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
