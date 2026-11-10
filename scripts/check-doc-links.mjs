import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
// Published Skill versions are immutable, so their links are not checked or edited here.
const skippedPrefixes = ["skills/builtin/"];

const linkPattern =
  /!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|(?:[^\s()]|\([^\s()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

function stripFencedCode(markdown) {
  const kept = [];
  let fence = null;
  for (const line of markdown.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        match &&
        match[1][0] === fence.char &&
        match[1].length >= fence.length &&
        line.trim() === match[1]
      ) {
        fence = null;
      }
      continue;
    }
    if (match) {
      fence = { char: match[1][0], length: match[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function stripInlineCode(markdown) {
  return markdown.replace(/(`+)[\s\S]*?\1/g, "");
}

function headingSlug(value) {
  return value
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

/** GitHub-style anchors of every ATX heading in one Markdown document. */
export function headingAnchors(markdown) {
  return new Set(
    [...stripFencedCode(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(
      (match) => headingSlug(match[1]),
    ),
  );
}

function readAnchors(file) {
  try {
    return headingAnchors(readFileSync(file, "utf8"));
  } catch {
    return new Set();
  }
}

/**
 * Returns the local link targets of one Markdown document that do not resolve,
 * including a fragment that names no heading of a linked Markdown file.
 * `exists` and `anchors` receive an absolute path.
 */
export function findBrokenLinks(
  markdown,
  file,
  { root = repositoryRoot, exists = existsSync, anchors = readAnchors } = {},
) {
  const text = stripInlineCode(stripFencedCode(markdown));
  const broken = [];
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1];
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(target) ||
      target.startsWith("#") ||
      target.startsWith("<") ||
      /[<{$]/.test(target)
    ) {
      continue;
    }
    const withoutSuffix = target.replace(/[#?].*$/s, "");
    if (withoutSuffix === "") continue;
    let decoded;
    try {
      decoded = decodeURIComponent(withoutSuffix);
    } catch {
      broken.push(target);
      continue;
    }
    const resolved = decoded.startsWith("/")
      ? path.join(root, decoded)
      : path.resolve(root, path.dirname(file), decoded);
    if (!exists(resolved)) {
      broken.push(target);
      continue;
    }
    const fragment = /#([^?]*)/.exec(target)?.[1];
    if (!fragment || !resolved.toLowerCase().endsWith(".md")) continue;
    let anchor;
    try {
      anchor = decodeURIComponent(fragment).toLowerCase();
    } catch {
      broken.push(target);
      continue;
    }
    if (!anchors(resolved).has(anchor)) broken.push(target);
  }
  return broken;
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z", "*.md"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(
      (file) =>
        file !== "" &&
        !skippedPrefixes.some((prefix) => file.startsWith(prefix)) &&
        existsSync(path.join(repositoryRoot, file)),
    );
  let failures = 0;
  for (const file of files) {
    const markdown = readFileSync(path.join(repositoryRoot, file), "utf8");
    for (const target of findBrokenLinks(markdown, file)) {
      console.log(`${file}: ${target}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(`${failures} broken Markdown link(s)`);
    process.exit(1);
  }
  console.log(`Checked Markdown links in ${files.length} files: all resolve`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
