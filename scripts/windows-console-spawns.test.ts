import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "..");

// The desktop, its installer and the native supervisor have no console on
// Windows. A console program they start without windowsHide opens a visible
// window; the setup page polls processes, so those windows keep appearing.
const roots = [
  "apps/desktop/src/main",
  "apps/linger-installer/src/server",
  "packages/local-installation/src",
];
const scripts = ["scripts/replace-process.mjs", "scripts/with-local-env.mjs"];
// These never start a process on Windows.
const posixOnly = new Set([
  "apps/desktop/src/main/mac-permissions.ts",
  "apps/desktop/src/main/shell-env.ts",
  "apps/desktop/src/main/updater.ts",
  "apps/linger-installer/src/server/platform.ts",
]);

function sources() {
  const files = [...scripts];
  for (const root of roots)
    for (const name of readdirSync(path.join(repository, root)))
      if (/\.(?:ts|mjs)$/.test(name) && !/\.test\.ts$/.test(name))
        files.push(`${root}/${name}`);
  return files.filter((file) => !posixOnly.has(file));
}

// The text of each spawn/execFile call, up to its closing parenthesis.
function calls(text: string) {
  const found: string[] = [];
  const pattern = /(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync)\(/g;
  for (const match of text.matchAll(pattern)) {
    let depth = 0;
    let end = match.index;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    found.push(text.slice(match.index, end + 1));
  }
  return found;
}

it("starts every Windows child process without a console window", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const file of sources()) {
    const text = readFileSync(path.join(repository, file), "utf8");
    for (const call of calls(text)) {
      checked++;
      if (!/windowsHide:\s*true/.test(call))
        missing.push(`${file}: ${call.split("\n")[0]}`);
    }
  }
  expect(checked).toBeGreaterThan(5);
  expect(missing).toEqual([]);
});
