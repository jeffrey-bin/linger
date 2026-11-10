// Builds the services Native runs from the source package the app ships, so
// installing them needs no network and no toolchain: Web's production files
// with its static host, Node Services bundled with esbuild
// (bundle-node-services.mjs) beside the production node_modules of what stays
// external, and the pinned Node.js release. Every target has the same layout;
// only the native packages in node_modules and the Node.js archive differ:
//
//   runtime/files.json                   schema, target, source, every file's sha256
//   runtime/node-services/dist/…         the bundles; dist/supervisor.js starts them
//   runtime/node-services/prompts/
//   runtime/node-services/models.json    model packages installed on first use
//   runtime/node-services/node_modules/
//   runtime/web/{dist/,static-host.mjs}
//
// They go to dist/installer/native/runtime-<target>/ as runtime.tar.zst beside
// the Node.js archive, with a manifest of both. On macOS, where the app's
// signature must cover every Mach-O file inside it, they go there as the
// runtime/ folder beside node/bin/node instead, unpacked
// (RUNTIME_LAYOUTS); packaging/mac/package.py signs them.
//
//   node scripts/build-native-runtime.mjs --target win32-x64 --source linger-<label>.tar.gz
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import zlib, { createZstdCompress } from "node:zlib";

import { build } from "esbuild";

import {
  NODE_RUNTIME_RELEASES,
  NODE_RUNTIME_VERSION,
  nodeRuntimeDownloadUrls,
} from "../../../scripts/local-computer-node-distributions.mjs";
import { bundleNodeServices } from "./bundle-node-services.mjs";
import { sourceCommit } from "./build-teamhub.mjs";

const desktop = fileURLToPath(new URL("../", import.meta.url));

export const RUNTIME_TARGETS = ["win32-x64", "linux-x64", "darwin-arm64"];
// The folder the archive holds, which the desktop unpacks into the source as
// .simplexai-runtime/offline (packages/local-installation/src/native-runtime.ts).
const ROOT = "runtime";
export const RUNTIME_ARCHIVE = "runtime.tar.zst";
export const RUNTIME_FILES = "files.json";
// Bumped when the layout above changes, so an older desktop refuses it.
export const RUNTIME_SCHEMA = 1;

// "archive": runtime.tar.zst and the Node.js release archive.
// "directory": the runtime/ folder and node/ with the Node.js binary.
export const RUNTIME_LAYOUTS = {
  "win32-x64": "archive",
  "linux-x64": "archive",
  "darwin-arm64": "directory",
};
export const RUNTIME_DIRECTORY = ROOT;
export const NODE_DIRECTORY = "node";

const PLATFORMS = {
  "win32-x64": { os: "win32", cpu: "x64" },
  "linux-x64": { os: "linux", cpu: "x64", libc: "glibc" },
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
};

// Packages the services load at runtime by a name esbuild cannot see:
// createRequire, require.resolve of data files, or a native binding.
const RUNTIME_PACKAGES = [
  "@livekit/local-inference",
  "@tesseract.js-data/chi_sim",
  "@tesseract.js-data/eng",
  "tesseract.js-core",
  "word-extractor",
];
// Packages that are model data rather than code: the installer leaves them
// out and Node Services downloads them when a feature first needs them
// (apps/node-services/src/model-packages.ts). Local models install
// separately as before.
export const MODEL_PACKAGE_GROUPS = [
  [/^@tesseract\.js-data\//, "ocr"],
  // Silero VAD and the turn detector, embedded in the binding.
  [/^@livekit\/local-inference-/, "voice"],
];
export const modelPackageGroup = (name) =>
  MODEL_PACKAGE_GROUPS.find(([pattern]) => pattern.test(name))?.[1];
// Registries holding the same tarballs; the lockfile integrity checks both.
const MODEL_REGISTRIES = [
  "https://registry.npmjs.org/",
  "https://registry.npmmirror.com/",
];
// Imports inside try/catch for features Native does not use; development
// does not install them either.
const OPTIONAL_IMPORTS = new Set([
  "@pdf-lib/fontkit",
  "bufferutil",
  "pdf-lib",
  "pnpapi",
  "puppeteer",
  // Only source files running under tsx register it.
  "tsx",
  "utf-8-validate",
]);

export const runtimeDirectory = (target) =>
  path.join(desktop, "dist/installer/native", `runtime-${target}`);

const sha256File = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
};

const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

// Source maps, type declarations, TypeScript sources and documentation that
// Node never loads from node_modules; licenses stay.
const unused = (file) => {
  const name = path.basename(file);
  return (
    !/^(?:licen[cs]e|notice|copying|authors)/i.test(name) &&
    /\.(?:map|[cm]?ts|tsx|md|markdown)$/i.test(name)
  );
};

// Copies the packages in `roots` and every package they depend on from the
// hoisted `deployed` node_modules into `output`, at the same paths, so Node
// resolves each the way it did there. Packages `exclude` accepts are listed
// in `excluded` with their version instead.
export async function copyExternals(
  deployed,
  output,
  roots,
  exclude = () => false,
) {
  const copied = new Map();
  const excluded = new Map();
  const missing = [];
  const find = (name, from) => {
    for (let directory = from; ; directory = path.dirname(directory)) {
      const candidate = path.join(directory, "node_modules", name);
      const relative = path.relative(deployed, candidate);
      if (relative.startsWith("..")) return;
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
      if (directory === deployed) return;
    }
  };
  const visit = async (name, from, required) => {
    const directory = find(name, from);
    if (!directory) {
      if (required)
        missing.push(`${name} (from ${path.relative(deployed, from) || "."})`);
      return;
    }
    if (copied.has(directory) || excluded.has(name)) return;
    const manifest = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    if (exclude(name)) {
      excluded.set(name, manifest.version);
      return;
    }
    copied.set(directory, manifest.version);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await visit(dependency, directory, true);
    // Platform packages for other computers are not installed.
    for (const dependency of Object.keys({
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }))
      await visit(dependency, directory, false);
  };
  for (const root of roots) await visit(root, deployed, true);
  if (missing.length)
    throw new Error(`Missing runtime packages: ${missing.join(", ")}`);
  for (const directory of copied.keys())
    await cp(directory, path.join(output, path.relative(deployed, directory)), {
      recursive: true,
      // Nested packages are copied on their own when something needs them.
      filter: (file) =>
        !path
          .relative(directory, file)
          .split(path.sep)
          .includes("node_modules") && !unused(file),
    });
  return {
    packages: [...copied].map(([directory, version]) => ({
      package: path.relative(deployed, directory).split(path.sep).join("/"),
      version,
    })),
    excluded: Object.fromEntries([...excluded].sort()),
  };
}

// models.json for the model packages `versions` lists, with each tarball's
// integrity from the source's lockfile.
export function modelPackages(lockfile, versions) {
  const packages = {};
  for (const [name, version] of Object.entries(versions)) {
    const quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const integrity = new RegExp(
      `\\n  '?${quoted}@${version.replaceAll(".", "\\.")}'?:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`,
    ).exec(lockfile)?.[1];
    if (!integrity)
      throw new Error(`pnpm-lock.yaml has no sha512 for ${name}@${version}`);
    const file = `${name.split("/").at(-1)}-${version}.tgz`;
    packages[name] = {
      group: modelPackageGroup(name),
      version,
      integrity,
      tarballs: MODEL_REGISTRIES.map(
        (registry) => `${registry}${name}/-/${file}`,
      ),
    };
  }
  return { packages };
}

// Every file under `root` with its size and sha256, by relative path.
async function listFiles(root) {
  const files = {};
  const walk = async (directory) => {
    for (const entry of (await readdir(directory)).sort()) {
      const file = path.join(directory, entry);
      const info = await lstat(file);
      if (info.isSymbolicLink())
        throw new Error(`${file} is a symbolic link; the runtime copies files`);
      if (info.isDirectory()) await walk(file);
      else
        files[path.relative(root, file).split(path.sep).join("/")] = {
          bytes: info.size,
          sha256: await sha256File(file),
        };
    }
  };
  await walk(root);
  return files;
}

// Node archives already downloaded by an earlier build; they are checked
// against the pinned sha256 like a download.
const nodeCache = path.join(desktop, "node_modules/.cache/linger-node");

async function downloadNode(target, output) {
  const release = NODE_RUNTIME_RELEASES[target];
  const file = path.join(output, release.archive);
  const cached = path.join(nodeCache, release.archive);
  if (existsSync(cached) && (await sha256File(cached)) === release.sha256) {
    await cp(cached, file);
    return {
      version: NODE_RUNTIME_VERSION,
      file: release.archive,
      sha256: release.sha256,
      bytes: (await stat(file)).size,
    };
  }
  for (const url of nodeRuntimeDownloadUrls(release.archive)) {
    const response = await fetch(url).catch(() => undefined);
    if (!response?.ok) continue;
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    if ((await sha256File(file)) !== release.sha256) continue;
    await mkdir(nodeCache, { recursive: true });
    await cp(file, cached);
    return {
      version: NODE_RUNTIME_VERSION,
      file: release.archive,
      sha256: release.sha256,
      bytes: (await stat(file)).size,
    };
  }
  throw new Error(
    `Could not download ${release.archive} with its pinned sha256`,
  );
}

// bin/node and the license from a Node.js release tar.gz, into `output`/node.
async function unpackNode(archive, output, work) {
  const unpacked = path.join(work, "node-release");
  await mkdir(unpacked);
  run("tar", ["-xzf", archive, "-C", unpacked, "--strip-components=1"]);
  const node = path.join(output, NODE_DIRECTORY);
  await mkdir(path.join(node, "bin"), { recursive: true });
  await cp(path.join(unpacked, "bin/node"), path.join(node, "bin/node"));
  await cp(path.join(unpacked, "LICENSE"), path.join(node, "LICENSE"));
  const binary = path.join(node, "bin/node");
  return {
    file: `${NODE_DIRECTORY}/bin/node`,
    sha256: await sha256File(binary),
    bytes: (await stat(binary)).size,
  };
}

// Throws unless `directory` holds the runtime its manifest lists, built for
// `target` from the package with `sourceArchiveSha256`.
export async function verifyRuntime(directory, target, sourceArchiveSha256) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8").catch(() => {
      throw new Error(`${directory} has no Native runtime for ${target}`);
    }),
  );
  if (
    manifest.schema !== RUNTIME_SCHEMA ||
    manifest.target !== target ||
    manifest.sourceArchiveSha256 !== sourceArchiveSha256
  )
    throw new Error(
      `${directory} holds a Native runtime for another target or source package`,
    );
  const layout = RUNTIME_LAYOUTS[target];
  if ((manifest.layout ?? "archive") !== layout)
    throw new Error(`${directory} holds a Native runtime of another layout`);
  const items = [
    layout === "directory" ? manifest.directory : manifest.archive,
    manifest.node,
  ];
  if (layout === "directory") {
    const files = JSON.parse(
      await readFile(path.join(directory, ROOT, RUNTIME_FILES), "utf8"),
    ).files;
    for (const [file, item] of Object.entries(files))
      items.push({ ...item, file: `${ROOT}/${file}` });
  }
  for (const item of items) {
    const file = path.join(directory, item?.file ?? "missing");
    const bytes = await stat(file).then(
      (info) => info.size,
      () => -1,
    );
    if (bytes !== item?.bytes || (await sha256File(file)) !== item.sha256)
      throw new Error(`${file} does not match ${directory}/manifest.json`);
  }
  return manifest;
}

export async function buildRuntime(
  target,
  archive,
  output = runtimeDirectory(target),
) {
  const platform = PLATFORMS[target];
  if (!platform || !NODE_RUNTIME_RELEASES[target])
    throw new Error(`Unknown Native runtime target ${target}`);
  const sourceArchiveSha256 = await sha256File(archive);
  const commit = await sourceCommit(archive);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), "linger-runtime-"));
  const timings = {};
  const timed = async (name, action) => {
    const started = Date.now();
    const result = await action();
    timings[name] = Math.round((Date.now() - started) / 100) / 10;
    console.log(`native runtime: ${name} took ${timings[name]}s`);
    return result;
  };
  try {
    const source = path.join(work, "source");
    const root = path.join(work, ROOT);
    const services = path.join(root, "node-services");
    const web = path.join(root, "web");
    await mkdir(source);
    run("tar", ["-xzf", archive, "-C", source, "--strip-components=1"]);
    await timed("install", () =>
      run(
        "pnpm",
        [
          "install",
          "--filter",
          "@linger/node-services...",
          "--filter",
          "@linger/web...",
          "--frozen-lockfile",
          "--prefer-offline",
          "--reporter",
          "append-only",
        ],
        { cwd: source },
      ),
    );
    await timed("web", async () => {
      run("pnpm", ["--filter", "@linger/web", "build:assets"], {
        cwd: source,
      });
      // The precompressed twins halve Web's share of the package and save
      // nothing on loopback; the host serves the plain file without them.
      await cp(path.join(source, "apps/web/dist"), path.join(web, "dist"), {
        recursive: true,
        filter: (file) =>
          !/\.(?:gz|br)$/.test(file) ||
          !existsSync(file.replace(/\.(?:gz|br)$/, "")),
      });
      await build({
        absWorkingDir: path.join(source, "apps/web"),
        entryPoints: [path.join(source, "apps/web/static-host.mjs")],
        outfile: path.join(web, "static-host.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node26",
        logLevel: "warning",
      });
    });
    const bundled = await timed("node-services", async () => {
      const result = await bundleNodeServices(source, services);
      await cp(
        path.join(source, "apps/node-services/prompts"),
        path.join(services, "prompts"),
        { recursive: true },
      );
      await writeFile(
        path.join(services, "package.json"),
        JSON.stringify(
          { name: "@linger/node-services", private: true, type: "module" },
          null,
          2,
        ),
      );
      return result;
    });
    const packages = await timed("externals", async () => {
      const deployed = path.join(work, "deploy");
      run(
        "pnpm",
        [
          "--filter",
          "@linger/node-services",
          "deploy",
          "--config.inject-workspace-packages=true",
          "--config.node-linker=hoisted",
          "--prod",
          // Every native package here ships prebuilt per platform.
          "--ignore-scripts",
          `--os=${platform.os}`,
          `--cpu=${platform.cpu}`,
          ...(platform.libc ? [`--libc=${platform.libc}`] : []),
          deployed,
        ],
        { cwd: source },
      );
      const builtins = new Set(builtinModules);
      const roots = new Set(RUNTIME_PACKAGES);
      for (const specifier of bundled.imports) {
        const name = packageName(specifier);
        if (!builtins.has(name) && !OPTIONAL_IMPORTS.has(name)) roots.add(name);
      }
      const copied = await copyExternals(
        deployed,
        services,
        [...roots].sort(),
        modelPackageGroup,
      );
      await writeFile(
        path.join(services, "models.json"),
        JSON.stringify(
          modelPackages(
            await readFile(path.join(source, "pnpm-lock.yaml"), "utf8"),
            copied.excluded,
          ),
          null,
          2,
        ),
      );
      return copied;
    });
    const layout = RUNTIME_LAYOUTS[target];
    let node = await timed("node", () => downloadNode(target, output));
    await timed("archive", async () => {
      const files = await listFiles(root);
      await writeFile(
        path.join(root, RUNTIME_FILES),
        JSON.stringify(
          {
            schema: RUNTIME_SCHEMA,
            target,
            sourceCommit: commit,
            sourceArchiveSha256,
            files,
          },
          null,
          1,
        ),
      );
      if (layout === "directory") return;
      run("tar", [
        "--sort=name",
        "--format=posix",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mtime=@0",
        "-cf",
        path.join(work, "runtime.tar"),
        "-C",
        work,
        ROOT,
      ]);
      // zstd keeps a quarter less than gzip -9 and unpacks faster; the desktop
      // decompresses it with Node's zlib, since Windows' tar may lack zstd.
      await pipeline(
        createReadStream(path.join(work, "runtime.tar")),
        createZstdCompress({
          params: {
            [zlib.constants.ZSTD_c_compressionLevel]: 12,
            [zlib.constants.ZSTD_c_windowLog]: 24,
          },
        }),
        createWriteStream(path.join(output, RUNTIME_ARCHIVE)),
      );
    });
    await timed("report", async () => {
      const files = JSON.parse(
        await readFile(path.join(root, RUNTIME_FILES), "utf8"),
      ).files;
      const report = {
        files: Object.keys(files).length,
        bytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0),
        bundles: bundled.files,
        packages: packages.packages,
        models: packages.excluded,
      };
      await writeFile(
        path.join(output, "report.json"),
        JSON.stringify({ ...report, timings }, null, 2),
      );
    });
    let contents;
    if (layout === "directory") {
      await cp(root, path.join(output, ROOT), { recursive: true });
      const release = path.join(output, node.file);
      node = {
        version: node.version,
        ...(await unpackNode(release, output, work)),
      };
      await rm(release);
      const files = path.join(output, ROOT, RUNTIME_FILES);
      contents = {
        layout,
        directory: {
          file: `${ROOT}/${RUNTIME_FILES}`,
          sha256: await sha256File(files),
          bytes: (await stat(files)).size,
        },
      };
    } else {
      const archived = path.join(output, RUNTIME_ARCHIVE);
      contents = {
        layout,
        archive: {
          file: RUNTIME_ARCHIVE,
          sha256: await sha256File(archived),
          bytes: (await stat(archived)).size,
        },
      };
    }
    await writeFile(
      path.join(output, "manifest.json"),
      JSON.stringify(
        {
          schema: RUNTIME_SCHEMA,
          target,
          sourceCommit: commit,
          sourceArchiveSha256,
          ...contents,
          node,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return verifyRuntime(output, target, sourceArchiveSha256);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  if (!args.includes("--target") || !args.includes("--source"))
    throw new Error(
      "Usage: build-native-runtime.mjs --target win32-x64 --source ARCHIVE [--output DIR]",
    );
  console.log(
    JSON.stringify(
      await buildRuntime(
        value("--target"),
        value("--source"),
        args.includes("--output") ? path.resolve(value("--output")) : undefined,
      ),
      null,
      2,
    ),
  );
}
