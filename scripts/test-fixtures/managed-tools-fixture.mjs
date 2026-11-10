import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const digest = (data) => createHash("sha256").update(data).digest("hex");
export async function managedToolsFixture(
  source,
  id,
  version = "0.6.0",
  teamhubVersion = version,
) {
  await mkdir(path.join(source, "cli/manifests"), { recursive: true });
  const tools = {};
  for (const tool of ["teamhub", "lev8"]) {
    const toolVersion = tool === "teamhub" ? teamhubVersion : version;
    const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '${tool} ${toolVersion}\\n'; else printf '%s\\n' "$0"; printf '${toolVersion}\\n'; fi\n`;
    const blocks = [];
    for (const [name, content] of [
      [tool, script],
      ["files.sha256", `${digest(script)}  ${tool}\n`],
    ]) {
      const bytes = Buffer.from(content);
      const header = Buffer.alloc(512);
      header.write(name, 0, 100);
      header.write("0000755\0", 100, 8);
      header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12);
      header.write("        ", 148, 8);
      header.write("0", 156, 1);
      header.write("ustar\0", 257, 6);
      header.write(
        header
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
        148,
        8,
      );
      blocks.push(
        header,
        bytes,
        Buffer.alloc((512 - (bytes.length % 512)) % 512),
      );
    }
    const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
    const artifact = `cli/${id}-${tool}.tar.gz`;
    await writeFile(path.join(source, artifact), archive);
    tools[tool] = {
      version: toolVersion,
      // These fixtures contain portable shell scripts, not native binaries.
      // Launcher tests and resident Runtime installs use real host detection.
      artifacts: Object.fromEntries(
        ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"].map(
          (platform) => [
            platform,
            {
              path: artifact,
              size: archive.length,
              sha256: digest(archive),
            },
          ],
        ),
      ),
    };
  }
  await writeFile(
    path.join(source, `cli/manifests/${id}.json`),
    JSON.stringify({
      schema: 1,
      release_id: id,
      node: { version: "26.5.0" },
      tools,
    }),
  );
}

// Deny writes in the launcher process even when tests run as root. This models
// the Provider's read-only tool mount without requiring a privileged sandbox.
export async function writeManagedToolsReadOnlyGuard(filename, root) {
  await writeFile(
    filename,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const root = ${JSON.stringify(root)};
for (const name of ["mkdir", "writeFile", "rename", "rm", "rmdir", "symlink"]) {
  const original = fs[name];
  fs[name] = async (...args) => {
    for (const value of args.slice(0, ["rename", "symlink"].includes(name) ? 2 : 1)) {
      if (typeof value !== "string") continue;
      const target = path.resolve(value);
      if (target === root || target.startsWith(root + path.sep))
        throw Object.assign(new Error("Read-only managed tool root: " + name), { code: "EROFS" });
    }
    return original(...args);
  };
}
syncBuiltinESMExports();
`,
  );
}
