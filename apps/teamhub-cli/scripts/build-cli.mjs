import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--outdir"))
  throw new Error("Use build-cli.mjs [--outdir <directory>].");
const outputRoot = path.resolve(args[1] ?? path.join(appRoot, "dist"));
const result = await build({
  absWorkingDir: appRoot,
  entryPoints: { teamhub: "src/main.ts" },
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node26",
  minifyWhitespace: true,
  outdir: outputRoot,
  chunkNames: "teamhub-chunks/[name]-[hash]",
  write: false,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const outputs = result.outputFiles
  .map((file) => ({
    path: path.relative(outputRoot, file.path).split(path.sep).join("/"),
    contents: file.contents,
  }))
  .sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
const assets = outputs.map((file) => ({
  path: file.path,
  size_bytes: file.contents.length,
  sha256: createHash("sha256").update(file.contents).digest("hex"),
}));
const manifest = {
  schema_version: 1,
  entrypoint: "teamhub.js",
  assets,
  artifact_sha256: createHash("sha256")
    .update(JSON.stringify(assets))
    .digest("hex"),
};
const install = async (relativePath, content) => {
  const filename = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o644, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
};
// Install content-addressed dependencies first. Keep older chunks available for
// a CLI already running from the previous entry; distribution uses this manifest.
for (const file of outputs.filter((file) => file.path !== "teamhub.js"))
  await install(file.path, file.contents);
await install("teamhub-assets.json", JSON.stringify(manifest, null, 2) + "\n");
// Command metadata for hosts, written beside the CLI rather than exposed as a
// command so Agents never spend tokens on it. It is not a CLI asset.
const commandManifestBuild = await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/command-manifest.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  write: false,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const commandManifestModule = path.join(
  tmpdir(),
  `teamhub-command-manifest-${randomUUID()}.mjs`,
);
try {
  await writeFile(
    commandManifestModule,
    commandManifestBuild.outputFiles[0].contents,
  );
  const { commandManifest } = await import(
    pathToFileURL(commandManifestModule).href
  );
  await install(
    "teamhub-commands.json",
    JSON.stringify(commandManifest(), null, 2) + "\n",
  );
} finally {
  await rm(commandManifestModule, { force: true });
}
await install(
  "teamhub.js",
  outputs.find((file) => file.path === "teamhub.js").contents,
);
