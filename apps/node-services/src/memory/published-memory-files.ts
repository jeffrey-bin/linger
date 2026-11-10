import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withDirectoryLock } from "./filesystem-lock.js";
import {
  markMemoryChanged,
  walkFiles,
  writeAtomicJsonFile,
} from "./fs-utils.js";
import { localMeetingTime, localDate } from "./date.js";
import { parseMemoryMarkdown } from "./markdown.js";
import { agentMemoryRoot, agentWorkspaceRoot } from "./paths.js";
import type { WikiPage } from "./teamhub-wiki.js";

export interface PublishedFile {
  page: Pick<WikiPage, "documentId" | "path">;
  content: string;
}
const folders = new Map([
  ["contacts", "knowledge/people"],
  ["clients", "knowledge/clients"],
  ["projects", "knowledge/projects"],
  ["topics", "knowledge/topics"],
  ["sessions", "timeline/meetings"],
]);

function readableName(value: string): string {
  const clean = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*#%\p{Cc}]/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/^[. ]+|[. ]+$/gu, "");
  // Keep room for the date, extension and a disambiguating ID even for CJK titles.
  return [...clean].slice(0, 48).join("") || "Untitled";
}

/** Published page IDs stay stable. Only filenames in the reader's tree use titles. */
function memoryWikiFiles(
  pages: readonly PublishedFile[],
  starts: ReadonlyMap<string, Date>,
) {
  const paths = new Map<string, string>();
  const taken = new Set<string>();
  const directories = new Map<string, string>([["index.md", "knowledge"]]);
  for (const { page, content } of [...pages].sort((a, b) =>
    a.page.path.localeCompare(b.page.path, "en"),
  )) {
    const [group] = page.path.split("/");
    const folder = folders.get(group!);
    if (!folder) continue;
    if (path.posix.basename(page.path) === "index.md") {
      directories.set(page.path, folder);
      continue;
    }
    const start =
      group === "sessions"
        ? starts.get(path.posix.basename(page.path, ".md"))
        : undefined;
    if (group === "sessions" && !start) continue;
    const name = start
      ? localDate(start) + " " + localMeetingTime(start)
      : readableName(parseMemoryMarkdown(content).title);
    const stem = folder + "/" + name;
    let target = stem + ".md";
    let i = 0;
    while (
      taken.has(target.toLowerCase()) ||
      path.basename(target).toLowerCase() === "index.md"
    )
      target =
        stem +
        " - " +
        createHash("sha256")
          .update(page.documentId + ":" + i++)
          .digest("hex")
          .slice(0, 10) +
        ".md";
    taken.add(target.toLowerCase());
    paths.set(page.path, target);
  }
  const files = new Map<string, string>();
  for (const { page, content } of pages) {
    const dest = paths.get(page.path);
    if (!dest) continue;
    const body = content.replace(
      /(?<!!)(\[[^\]\n]*\]\()(<[^>]+>|[^\s)]+)(\s+["'][^)]*["'])?\)/gu,
      (whole, start: string, href: string, title: string | undefined) => {
        const url = href.replace(/^<|>$/gu, "");
        if (/^(?:#|[a-z][a-z\d+.-]*:|\/\/)/iu.test(url)) return whole;
        const split = url.search(/[?#]/u);
        const name = split < 0 ? url : url.slice(0, split);
        const suffix = split < 0 ? "" : url.slice(split);
        if (!name) return whole;
        const key = path.posix.normalize(
          name.startsWith("/")
            ? name.slice(1)
            : path.posix.join(path.posix.dirname(page.path), name),
        );
        const other =
          paths.get(key) ??
          paths.get(key + ".md") ??
          paths.get(path.posix.join(key, "index.md")) ??
          directories.get(key) ??
          directories.get(path.posix.join(key, "index.md"));
        if (!other) {
          // An unavailable capture has no readable local meeting page.
          return key.startsWith("sessions/") ? start.slice(1, -2) : whole;
        }
        const relative =
          path.posix.relative(path.posix.dirname(dest), other) || ".";
        return (
          start +
          relative
            .split("/")
            .map((part) =>
              encodeURIComponent(part)
                .replaceAll("(", "%28")
                .replaceAll(")", "%29"),
            )
            .join("/") +
          (suffix ?? "") +
          (title ?? "") +
          ")"
        );
      },
    );
    files.set(dest, body);
  }
  return { files, paths };
}

/** Replace changed pages before retiring old names. A retry reconciles the complete revision. */
export async function publishMemoryWiki(
  dataRoot: string,
  agent: string,
  pages: readonly PublishedFile[],
  starts: ReadonlyMap<string, Date>,
): Promise<void> {
  const root = agentMemoryRoot(dataRoot, agent);
  const state = path.join(agentWorkspaceRoot(dataRoot, agent), "memory-state");
  const { files, paths } = memoryWikiFiles(pages, starts);
  await withDirectoryLock(state, async () => {
    let changed = false;
    try {
      const names = new Set(
        [...files.keys()].map((name) => name.toLowerCase()),
      );
      for (const folder of ["knowledge", "timeline/meetings"]) {
        for await (const file of walkFiles(path.join(root, folder))) {
          const current = path
            .relative(root, file)
            .split(path.sep)
            .join("/")
            .normalize("NFC");
          if (!files.has(current) && names.has(current.toLowerCase())) {
            await fs.unlink(file);
            changed = true;
          }
        }
      }
      for (const [name, content] of files) {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const current = await fs
          .readFile(file, "utf8")
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
        if (current === content) continue;
        const tmp = path.join(state, randomUUID());
        try {
          await fs.writeFile(tmp, content, { flag: "wx", mode: 0o600 });
          await fs.rename(tmp, file);
          changed = true;
        } finally {
          await fs.rm(tmp, { force: true });
        }
      }
      for (const folder of ["knowledge", "timeline/meetings"])
        for await (const file of walkFiles(path.join(root, folder))) {
          if (
            !files.has(
              path
                .relative(root, file)
                .split(path.sep)
                .join("/")
                .normalize("NFC"),
            )
          ) {
            await fs.unlink(file);
            changed = true;
          }
        }
      await writeAtomicJsonFile(
        path.join(state, "wiki-file-paths.json"),
        Object.fromEntries(paths),
      );
    } finally {
      if (changed) await markMemoryChanged(dataRoot, agent);
    }
  });
}
