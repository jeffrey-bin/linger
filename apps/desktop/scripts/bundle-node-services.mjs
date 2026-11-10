// Bundles Node Services (and the Voice workers it starts) with esbuild into
// the files `tsc` would write, inside `output` laid out like the package:
//
//   dist/{main,document/worker,…}.js
//   node_modules/@linger/voice-runtime/dist/{main,agent,…}.js
//
// Node Services finds its workers and prompts from its package directory
// (src/paths.ts), which each entry gets as LINGER_PACKAGE_ROOT; the Voice
// workers sit beside each other as in dist/. Packages with native code or
// files they load at runtime stay external and come from the production
// node_modules (see build-native-runtime.mjs).
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Native addons, wasm or worker files these packages read beside themselves,
// or child processes they start from their own files.
export const NODE_SERVICES_EXTERNALS = [
  "@livekit/*",
  "@napi-rs/canvas",
  "@napi-rs/canvas-*",
  "better-sqlite3",
  "sharp",
  "@img/*",
  "pdfjs-dist",
  "tesseract.js",
  "tesseract.js-core",
  "@tesseract.js-data/*",
  "jsdom",
  // Loads file-type, pdfjs-dist and its parsers by name at runtime.
  "officeparser",
  // Development only: source files register it when they run as .ts.
  "tsx",
];

const NODE_SERVICES_ENTRIES = [
  "main",
  "document/worker",
  "document/computation-worker",
  "document-normalizer/document-normalizer-worker",
];
const VOICE_ENTRIES = ["main", "agent", "recorder-agent", "live-agent"];

// The package directory as a URL relative to the bundled file `outputFile`.
export const packageRootFrom = (outputFile) =>
  `${path.posix.relative(path.posix.dirname(outputFile), ".") || "."}/`;

async function bundle(repo, output, entry, outputFile, define = {}) {
  const result = await build({
    absWorkingDir: repo,
    entryPoints: [path.join(repo, entry)],
    outfile: path.join(output, outputFile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    // The source exports of workspace packages, like `tsx` in development.
    conditions: ["import", "node"],
    mainFields: ["module", "main"],
    external: NODE_SERVICES_EXTERNALS,
    define,
    legalComments: "none",
    minifyWhitespace: true,
    minifySyntax: true,
    metafile: true,
    logLevel: "warning",
    banner: {
      // CommonJS dependencies inside the bundle require Node's builtins.
      js: 'import { createRequire as __lingerRequire } from "node:module"; const require = __lingerRequire(import.meta.url);',
    },
  });
  return result.metafile;
}

export async function bundleNodeServices(repo, output) {
  const files = [];
  const inputs = new Set();
  // Bare imports the bundles left for node_modules.
  const imports = new Set();
  const record = (metafile) => {
    for (const [file, info] of Object.entries(metafile.outputs)) {
      files.push({ file, bytes: info.bytes });
      for (const input of Object.keys(info.inputs)) inputs.add(input);
      for (const item of info.imports)
        if (item.external && !item.path.startsWith("node:"))
          imports.add(item.path);
    }
  };
  const nodeServices = (entry, outputFile) =>
    bundle(repo, output, entry, outputFile, {
      LINGER_PACKAGE_ROOT: JSON.stringify(packageRootFrom(outputFile)),
    });
  for (const entry of NODE_SERVICES_ENTRIES)
    record(
      await nodeServices(
        `apps/node-services/src/${entry}.ts`,
        `dist/${entry}.js`,
      ),
    );
  for (const entry of VOICE_ENTRIES)
    record(
      await bundle(
        repo,
        output,
        `apps/voice-runtime/src/${entry}.ts`,
        `node_modules/@linger/voice-runtime/dist/${entry}.js`,
      ),
    );
  // Waits for TeamHub and restarts the service after a crash, as in
  // development (scripts/dev-supervisor.ts --compiled).
  record(
    await nodeServices(
      "apps/node-services/scripts/dev-supervisor.ts",
      "dist/supervisor.js",
    ),
  );
  const worker = "src/agent/observability/agent-log-file-worker.mjs";
  await mkdir(path.join(output, "dist/agent/observability"), {
    recursive: true,
  });
  await copyFile(
    path.join(repo, "apps/node-services", worker),
    path.join(output, "dist/agent/observability/agent-log-file-worker.mjs"),
  );
  // The worker's package exports and module type.
  await writeFile(
    path.join(output, "node_modules/@linger/voice-runtime/package.json"),
    JSON.stringify(
      {
        name: "@linger/voice-runtime",
        private: true,
        type: "module",
        exports: { "./worker": { default: "./dist/main.js" } },
      },
      null,
      2,
    ),
  );
  return { files, inputs: [...inputs], imports };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repo, output] = process.argv.slice(2);
  const result = await bundleNodeServices(
    path.resolve(repo),
    path.resolve(output),
  );
  for (const { file, bytes } of result.files)
    console.log(`${(bytes / 1e6).toFixed(2).padStart(7)} MB ${file}`);
  console.log([...result.imports].sort().join("\n"));
}
