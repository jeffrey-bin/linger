import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".xml",
]);
const reactDevelopmentMarkers = [
  "A React Element from an older version of React was rendered",
  "Each child in a list should have a unique",
];

export const webInitialJavaScriptBudget = {
  brotliBytes: 180_000,
  gzipBytes: 210_000,
  minifiedBytes: 1_000_000,
};

export async function prepareProductionAssets({
  budget = webInitialJavaScriptBudget,
  root,
}) {
  const outputRoot = resolve(root);
  const manifest = JSON.parse(
    await readFile(join(outputRoot, ".vite", "manifest.json"), "utf8"),
  );
  const initialFiles = resolveInitialJavaScriptFiles(manifest);
  const productionJavaScriptFiles = resolveProductionJavaScriptFiles(manifest);
  const compressedAssets = await precompressStaticAssets(outputRoot);
  const initialJavaScript = await measureInitialJavaScript(
    outputRoot,
    initialFiles,
    compressedAssets,
  );

  await assertProductionReact(outputRoot, productionJavaScriptFiles);
  assertWithinBudget(initialJavaScript, budget);

  return {
    compressedAssetCount: compressedAssets.size,
    initialJavaScript: {
      brotliBytes: initialJavaScript.brotliBytes,
      files: initialFiles,
      gzipBytes: initialJavaScript.gzipBytes,
      minifiedBytes: initialJavaScript.minifiedBytes,
    },
  };
}

function resolveProductionJavaScriptFiles(manifest) {
  const files = new Set();
  for (const chunk of Object.values(manifest)) {
    if (/\.m?js$/i.test(chunk.file)) {
      files.add(chunk.file);
    }
  }
  return [...files];
}

function resolveInitialJavaScriptFiles(manifest) {
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry);
  if (entries.length !== 1) {
    throw new Error(
      `Expected one Web entry in the Vite manifest, found ${entries.length}.`,
    );
  }

  const files = [];
  const visitedChunks = new Set();
  const visit = (manifestKey) => {
    if (visitedChunks.has(manifestKey)) {
      return;
    }
    visitedChunks.add(manifestKey);

    const chunk = manifest[manifestKey];
    if (!chunk) {
      throw new Error(`Missing Vite manifest chunk: ${manifestKey}`);
    }
    if (/\.m?js$/i.test(chunk.file) && !files.includes(chunk.file)) {
      files.push(chunk.file);
    }
    for (const importedKey of chunk.imports ?? []) {
      visit(importedKey);
    }
  };

  visit(entries[0][0]);
  return files;
}

async function precompressStaticAssets(root) {
  const sourceFiles = await listCompressibleFiles(root);
  const compressedAssets = new Map();

  await Promise.all(
    sourceFiles.map(async (absolutePath) => {
      const source = await readFile(absolutePath);
      const [brotli, gzipped] = await Promise.all([
        compressBrotli(source, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          },
        }),
        compressGzip(source, { level: 9 }),
      ]);
      const relativePath = normalizePath(relative(root, absolutePath));
      const variants = {
        brotliBytes: Math.min(source.length, brotli.length),
        gzipBytes: Math.min(source.length, gzipped.length),
      };

      await Promise.all([
        brotli.length < source.length
          ? writeFile(`${absolutePath}.br`, brotli)
          : undefined,
        gzipped.length < source.length
          ? writeFile(`${absolutePath}.gz`, gzipped)
          : undefined,
      ]);
      compressedAssets.set(relativePath, variants);
    }),
  );

  return compressedAssets;
}

async function listCompressibleFiles(root) {
  const files = [];
  const directoryScans = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      directoryScans.push(listCompressibleFiles(absolutePath));
    } else if (
      entry.isFile() &&
      compressibleExtensions.has(extname(entry.name).toLowerCase())
    ) {
      files.push(absolutePath);
    }
  }

  const nestedFiles = await Promise.all(directoryScans);
  files.push(...nestedFiles.flat());
  return files;
}

async function measureInitialJavaScript(root, files, compressedAssets) {
  const assets = await Promise.all(
    files.map(async (file) => {
      const contents = await readFile(join(root, file));
      const compressed = compressedAssets.get(file);
      if (!compressed) {
        throw new Error(`Initial JavaScript asset was not measured: ${file}`);
      }
      return { contents, ...compressed };
    }),
  );

  return {
    brotliBytes: sum(assets, "brotliBytes"),
    contents: assets.map((asset) => asset.contents),
    gzipBytes: sum(assets, "gzipBytes"),
    minifiedBytes: assets.reduce(
      (total, asset) => total + asset.contents.length,
      0,
    ),
  };
}

async function assertProductionReact(root, files) {
  const sources = await Promise.all(
    files.map((file) => readFile(join(root, file), "utf8")),
  );
  for (const code of sources) {
    const marker = reactDevelopmentMarkers.find((candidate) =>
      code.includes(candidate),
    );
    if (marker) {
      throw new Error(
        `React development bundle detected in production output (${marker}).`,
      );
    }
  }
}

function assertWithinBudget(measured, budget) {
  const metrics = [
    ["minified", measured.minifiedBytes, budget.minifiedBytes],
    ["gzip", measured.gzipBytes, budget.gzipBytes],
    ["Brotli", measured.brotliBytes, budget.brotliBytes],
  ];
  const failures = metrics.filter(([, actual, maximum]) => actual > maximum);
  if (failures.length) {
    throw new Error(
      failures
        .map(
          ([name, actual, maximum]) =>
            `Initial JavaScript ${name} budget exceeded: ${formatBytes(actual)} > ${formatBytes(maximum)}.`,
        )
        .join("\n"),
    );
  }
}

function sum(values, key) {
  return values.reduce((total, value) => total + value[key], 0);
}

function normalizePath(pathname) {
  return pathname.split("\\").join("/");
}

function formatBytes(bytes) {
  return `${(bytes / 1_000).toFixed(2)} kB`;
}

function printReport(result) {
  const { initialJavaScript } = result;
  process.stdout.write(
    [
      "Web production initial JavaScript load graph",
      `  files: ${initialJavaScript.files.join(", ")}`,
      `  minified: ${formatBytes(initialJavaScript.minifiedBytes)} / ${formatBytes(webInitialJavaScriptBudget.minifiedBytes)}`,
      `  gzip: ${formatBytes(initialJavaScript.gzipBytes)} / ${formatBytes(webInitialJavaScriptBudget.gzipBytes)}`,
      `  Brotli: ${formatBytes(initialJavaScript.brotliBytes)} / ${formatBytes(webInitialJavaScriptBudget.brotliBytes)}`,
      `  compressed assets: ${result.compressedAssetCount}`,
      "",
    ].join("\n"),
  );
}

if (isMainModule()) {
  prepareProductionAssets({ root: process.argv[2] ?? "dist" })
    .then(printReport)
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`,
      );
      process.exitCode = 1;
    });
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return (
    typeof entrypoint === "string" &&
    pathToFileURL(resolve(entrypoint)).href === import.meta.url
  );
}
