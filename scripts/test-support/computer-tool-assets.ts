import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Installer tests already replace Node and Go with fixture executables. Keep
// tool assets small here too; the real pinned packages have separate protocol
// and standalone bundle checks. The real manifest validator remains enabled.
export const stageFixtureComputerTools = async (
  bundle: string,
  target: string,
) => {
  const root = path.join(bundle, "cli/computer-tools");
  const files = [
    "extensions/pi-mcp.mjs",
    "node_modules/@playwright/mcp/cli.js",
  ];
  if (target.startsWith("darwin-"))
    files.push("cua/cua-driver", "cua/CuaDriver.app/Contents/MacOS/cua-driver");
  if (target.startsWith("win32-")) files.push("cua/cua-driver.exe");
  const assets = [];
  for (const name of files.sort()) {
    const file = path.join(root, name);
    const content = `// Fixture Computer tool: ${name}\n`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { mode: 0o644 });
    assets.push({
      path: name,
      size_bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      mode: 0o644,
    });
  }
  await writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      versions: { playwright: "0.0.83", pi: "1.2.0", cua: "0.35.4" },
      target,
      playwright_entry: "node_modules/@playwright/mcp/cli.js",
      pi_extension: "extensions/pi-mcp.mjs",
      cua_entry: target.startsWith("darwin-")
        ? "cua/cua-driver"
        : target.startsWith("win32-")
          ? "cua/cua-driver.exe"
          : "",
      assets,
      artifact_sha256: createHash("sha256")
        .update(JSON.stringify(assets))
        .digest("hex"),
    }),
  );
};
