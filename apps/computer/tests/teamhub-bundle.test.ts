import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const launch = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

it("copies the complete current CLI artifact and runs it on the bundled runtime without workspace dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "computer-teamhub-artifact-"));
  try {
    const source = path.join(root, "apps/teamhub-cli/dist");
    const scripts = path.join(root, "apps/computer/scripts");
    const destination = path.join(root, "apps/computer/dist/bundle/cli");
    await mkdir(scripts, { recursive: true });
    await launch(process.execPath, [
      path.join(repositoryRoot, "apps/teamhub-cli/scripts/build-cli.mjs"),
      "--outdir",
      source,
    ]);
    const script = path.join(scripts, "bundle-teamhub-cli.mjs");
    await copyFile(
      path.join(repositoryRoot, "apps/computer/scripts/bundle-teamhub-cli.mjs"),
      script,
    );
    // Old build assets must not leak into a fresh distribution or remain after rebuilding it.
    await writeFile(
      path.join(source, "teamhub-chunks/obsolete-source.js"),
      "throw new Error('obsolete');",
    );
    await mkdir(path.join(destination, "teamhub-chunks"), { recursive: true });
    await writeFile(
      path.join(destination, "teamhub-chunks/obsolete-destination.js"),
      "throw new Error('obsolete');",
    );
    await launch(process.execPath, [script]);
    const manifest = JSON.parse(
      await readFile(path.join(destination, "teamhub-assets.json"), "utf8"),
    );
    expect(
      (await readdir(path.join(destination, "teamhub-chunks"))).sort(),
    ).toEqual(
      manifest.assets
        .filter((asset: { path: string }) =>
          asset.path.startsWith("teamhub-chunks/"),
        )
        .map((asset: { path: string }) => path.basename(asset.path))
        .sort(),
    );
    for (const asset of manifest.assets) {
      const content = await readFile(path.join(destination, asset.path));
      expect(content.length).toBe(asset.size_bytes);
      expect(createHash("sha256").update(content).digest("hex")).toBe(
        asset.sha256,
      );
    }
    const commands = JSON.parse(
      await readFile(path.join(destination, "teamhub-commands.json"), "utf8"),
    );
    expect(commands.schema_version).toBe(2);
    expect(commands.commands).toContainEqual({
      command: ["message", "read"],
      approval: "allow",
    });
    await writeFile(
      path.join(source, "teamhub.js"),
      "throw new Error('corrupt');",
    );
    await expect(launch(process.execPath, [script])).rejects.toThrow(
      /does not match its manifest/u,
    );
    const relocated = path.join(root, "cli");
    await rename(destination, relocated);
    await rm(path.join(root, "apps"), { recursive: true });
    // The launcher runs the bundled runtime beside cli/, never node on PATH.
    await mkdir(path.join(root, "runtime/bin"), { recursive: true });
    await symlink(process.execPath, path.join(root, "runtime/bin/node"));
    const tools = path.join(root, "path");
    await mkdir(tools);
    const dirname = await launch("/bin/sh", ["-c", "command -v dirname"]);
    await symlink(dirname.stdout.trim(), path.join(tools, "dirname"));
    const environment = {
      PATH: tools,
      TEAMHUB_CONFIG: path.join(root, "missing.json"),
    };
    const help = await launch(
      path.join(relocated, "teamhub"),
      ["docs", "--help"],
      {
        cwd: root,
        env: environment,
      },
    );
    expect(help.stdout).toContain("teamhub docs list");
    expect(help.stderr).toBe("");
    const schema = await launch(
      path.join(relocated, "teamhub"),
      ["message", "send", "--schema", "--json"],
      { cwd: root, env: environment },
    );
    expect(JSON.parse(schema.stdout).command).toEqual(["message", "send"]);
    expect(schema.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
