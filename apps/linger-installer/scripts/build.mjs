import { build } from "esbuild";
import { build as buildWeb } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await buildWeb({ configFile: path.join(root, "vite.config.ts"), root });
await build({
  entryPoints: [
    path.resolve(
      root,
      "../../packages/local-installation/src/native-process-worker.mjs",
    ),
  ],
  outfile: path.join(root, "dist/native-process-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
});
await build({
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(root, "dist/installer.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  external: ["node:*"],
  banner: { js: "#!/usr/bin/env node" },
});
