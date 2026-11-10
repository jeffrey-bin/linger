import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import {
  ensureNodeRuntimeArchive,
  NODE_RUNTIME_RELEASES,
  NODE_RUNTIME_VERSION,
} from "./local-computer-node-distributions.mjs";

import {
  MANAGED_TOOLS_RUNTIME_FILES,
  stageManagedToolsRuntime,
} from "./managed-tools-runtime-files.mjs";
import {
  stageComputerTools,
  validatedComputerToolAssets,
} from "../apps/computer/scripts/bundle-computer-tools.mjs";
import { publishWindowsInstallers } from "./publish-windows-installers.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const requireComputerBuildDependency = createRequire(
  pathToFileURL(path.join(repositoryRoot, "apps/computer/package.json")),
);
const tarStream = requireComputerBuildDependency("tar-stream");

export const RELEASE_TARGETS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);
// Windows on Arm is built only on request.
export const DEFAULT_RELEASE_TARGETS = Object.freeze(
  RELEASE_TARGETS.filter((target) => target !== "win32-arm64"),
);
const RELEASE_APPLICATION_ENTRIES = [
  ...MANAGED_TOOLS_RUNTIME_FILES.map((name) => `cli/${name}`),
  "cli/teamhub.js",
  "cli/teamhub",
];
const windows = (target) => target.startsWith("win32-");
const daemonEntry = (target) =>
  `daemon/linger-computer-daemon${windows(target) ? ".exe" : ""}`;
const cliEntry = (target) =>
  `cli/linger-computer${windows(target) ? ".exe" : ""}`;
const nodeEntry = (target) =>
  `runtime/bin/node${windows(target) ? ".exe" : ""}`;
// The Windows launcher serves as both the stable bin/linger-computer-*.exe
// commands and the TeamHub CLI entry.
const WINDOWS_LAUNCHER_ENTRY = "cli/teamhub.exe";
const INSTALLER_ENTRY = "installer/linger-computer.sh";
const RELEASE_TIMESTAMP = new Date("2000-01-01T00:00:00.000Z");
const GZIP_LEVEL = 9;

/**
 * `--part deps` writes only the dependency archives, `--part app` adds the
 * application archives and release.json next to the dependency archives in
 * `--deps`, and the default builds both into `--output`.
 */
export function parseReleaseArguments(arguments_, environment = process.env) {
  const options = {
    deps: null,
    output: path.join(repositoryRoot, ".linger-runtime/computer-release"),
    part: "all",
    targets:
      environment.COMPUTER_RELEASE_TARGETS?.trim() ||
      DEFAULT_RELEASE_TARGETS.join(","),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!["--deps", "--output", "--part", "--targets"].includes(argument)) {
      throw new Error(`Unknown release argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!["all", "app", "deps"].includes(options.part)) {
    throw new Error(`--part must be all, app or deps: ${options.part}`);
  }
  const targets = [
    ...new Set(options.targets.split(",").map((target) => target.trim())),
  ];
  for (const target of targets) {
    if (!RELEASE_TARGETS.includes(target)) {
      throw new Error(`Unsupported Local Computer release target: ${target}`);
    }
  }
  const output = path.resolve(repositoryRoot, options.output);
  return {
    deps: options.deps ? path.resolve(repositoryRoot, options.deps) : output,
    output,
    part: options.part,
    targets: RELEASE_TARGETS.filter((target) => targets.includes(target)),
  };
}

export async function prepareLocalComputerRelease(
  arguments_,
  {
    environment = process.env,
    stageNodeRuntime = stagePinnedNodeRuntime,
    stageToolRuntime = (bundle, target) =>
      stageComputerTools(bundle, { target }),
    stageGoBinaries = stageReleaseGoBinaries,
  } = {},
) {
  const options = parseReleaseArguments(arguments_, environment);
  const filesDirectory = path.join(options.output, "files");
  await mkdir(filesDirectory, { recursive: true });
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "linger-computer-release-"),
  );
  try {
    if (options.part !== "app") {
      await removeArchives(filesDirectory, "deps");
      await buildDependencyArchives(options.targets, filesDirectory, {
        stageNodeRuntime,
        stageToolRuntime,
        temporaryRoot,
      });
    }
    if (options.part === "deps") return { output: options.output };
    const deps = await readDependencyArchives(
      path.join(options.deps, "files"),
      options.targets,
    );
    await removeArchives(filesDirectory, "app");
    const version = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "apps/computer/package.json"),
        "utf8",
      ),
    ).version;
    const apps = await buildApplicationArchives(
      options.targets,
      filesDirectory,
      version,
      { stageGoBinaries, temporaryRoot },
    );
    const targets = Object.fromEntries(
      options.targets.map((target) => [
        target,
        { app: apps[target], deps: deps[target] },
      ]),
    );
    const release = { version, targets };
    // node-services renders these templates next to release.json.
    await publishWindowsInstallers(options.output);
    for (const name of [
      "install-linger-computer.sh",
      "uninstall-linger-computer.sh",
    ]) {
      await cp(
        path.join(repositoryRoot, "scripts", name),
        path.join(
          options.output,
          name === "install-linger-computer.sh" ? "linger-computer.sh" : name,
        ),
      );
    }
    await writeFile(
      path.join(options.output, "release.json"),
      `${JSON.stringify(release, null, 2)}\n`,
    );
    return { output: options.output, release };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

const removeArchives = async (directory, kind) => {
  for (const name of await readdir(directory)) {
    if (name.startsWith(`${kind}-`)) {
      await rm(path.join(directory, name), { force: true });
    }
  }
};

const readDependencyArchives = async (directory, targets) => {
  const names = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const archives = {};
  for (const target of targets) {
    const matches = names.filter((name) =>
      new RegExp(`^deps-${target}-[0-9a-f]{64}\\.tar\\.gz$`, "u").test(name),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected one dependency archive for ${target} in ${directory}.`,
      );
    }
    const file = path.join(directory, matches[0]);
    const digest = await sha256(file);
    if (matches[0] !== `deps-${target}-${digest}.tar.gz`) {
      throw new Error(`${matches[0]} does not match its sha256.`);
    }
    archives[target] = {
      file: matches[0],
      sha256: digest,
      size: (await stat(file)).size,
    };
  }
  return archives;
};

// Runs build steps concurrently. A failure rejects only after every task
// settles, so no child process outlives the temporary directory cleanup.
async function allSettledOrThrow(promises) {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((result) => result.value);
}

const buildDependencyArchives = async (
  targets,
  filesDirectory,
  { stageNodeRuntime, stageToolRuntime, temporaryRoot },
) => {
  if (stageNodeRuntime === stagePinnedNodeRuntime) {
    await Promise.all(targets.map(ensurePinnedNodeRuntimeArchive));
  }
  // Darwin targets share one cached Cua archive whose partial download path
  // is per-process, so their tool staging must not overlap.
  let toolGate = Promise.resolve();
  const stageTools = (bundle, target) => {
    if (!target.startsWith("darwin-")) return stageToolRuntime(bundle, target);
    const staged = toolGate.then(() => stageToolRuntime(bundle, target));
    toolGate = staged.catch(() => {});
    return staged;
  };
  const staging = path.join(temporaryRoot, "deps-archives");
  const archives = await allSettledOrThrow(
    targets.map(async (target) => {
      const bundle = path.join(temporaryRoot, "deps", target);
      await mkdir(bundle, { recursive: true });
      await allSettledOrThrow([
        stageNodeRuntime(bundle, target),
        stageTools(bundle, target),
      ]);
      const toolEntries = await validatedComputerToolAssets(bundle, target);
      const runtime = path.join(bundle, nodeEntry(target));
      if (((await stat(runtime)).mode & 0o111) === 0) {
        throw new Error("Release Node runtime is not executable.");
      }
      if (target === `${process.platform}-${process.arch}`) {
        const runtimeVersion = await runCapture(runtime, ["--version"]);
        if (runtimeVersion.trim() !== `v${NODE_RUNTIME_VERSION}`) {
          throw new Error(
            "Release Node runtime version does not match metadata.",
          );
        }
      }
      // The bash installer links these back into the bundle as runtime/ and
      // cli/computer-tools/; Windows unpacks both archives into one bundle,
      // so its entries keep their bundle paths.
      const entries = [
        [nodeEntry(target), nodeEntry(target)],
        ["runtime/LICENSE", "runtime/LICENSE"],
        ...toolEntries.map((entry) => [
          windows(target) ? entry : entry.slice("cli/".length),
          entry,
        ]),
      ];
      return await stageArchive(bundle, entries, staging, `deps-${target}`);
    }),
  );
  await publishArchives(archives, staging, filesDirectory);
};

const buildApplicationArchives = async (
  targets,
  filesDirectory,
  version,
  { stageGoBinaries, temporaryRoot },
) => {
  const applicationBundle = path.join(temporaryRoot, "application");
  await buildBundle(applicationBundle);
  await mkdir(path.join(applicationBundle, "installer"), { recursive: true });
  await cp(
    path.join(repositoryRoot, "scripts/install-linger-computer.sh"),
    path.join(applicationBundle, INSTALLER_ENTRY),
  );
  await chmod(path.join(applicationBundle, INSTALLER_ENTRY), 0o755);
  const cliEntries = await validatedApplicationEntries(applicationBundle);
  await assertApplicationBundle(applicationBundle, cliEntries);
  const staging = path.join(temporaryRoot, "app-archives");
  const archives = await allSettledOrThrow(
    targets.map(async (target) => {
      const bundle = path.join(temporaryRoot, "app", target);
      await cp(applicationBundle, bundle, { recursive: true });
      await stageGoBinaries(bundle, target, version);
      for (const entry of [daemonEntry(target), cliEntry(target)]) {
        if (((await stat(path.join(bundle, entry))).mode & 0o111) === 0)
          throw new Error(`Release ${entry} is not executable.`);
      }
      if (target === `${process.platform}-${process.arch}`) {
        const result = await runCapture(path.join(bundle, cliEntry(target)), [
          "version",
        ]);
        if (result.trim() !== `linger-computer ${version}`)
          throw new Error(
            "Release CLI version does not match release metadata.",
          );
      }
      // Windows does not update itself, so it needs no bash installer.
      const entries = [
        ...cliEntries,
        cliEntry(target),
        daemonEntry(target),
        ...(windows(target) ? [WINDOWS_LAUNCHER_ENTRY] : [INSTALLER_ENTRY]),
      ].map((entry) => [entry, entry]);
      return [
        target,
        await stageArchive(bundle, entries, staging, `app-${target}`),
      ];
    }),
  );
  await publishArchives(
    archives.map(([, archive]) => archive),
    staging,
    filesDirectory,
  );
  return Object.fromEntries(archives);
};

const buildBundle = async (outputDirectory) => {
  await stageManagedToolsRuntime(path.join(outputDirectory, "cli"));
  await run(process.execPath, [
    path.join(repositoryRoot, "apps/teamhub-cli/scripts/build-cli.mjs"),
    "--outdir",
    path.join(outputDirectory, "cli"),
  ]);
  await writeFile(
    path.join(outputDirectory, "cli/teamhub"),
    '#!/bin/sh\ncli_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$cli_dir/../runtime/bin/node" --use-env-proxy "$cli_dir/teamhub.js" "$@"\n',
    { mode: 0o755 },
  );
  await Promise.all(
    RELEASE_APPLICATION_ENTRIES.map((entry) =>
      chmod(path.join(outputDirectory, entry), 0o755),
    ),
  );
};

const stagePinnedNodeRuntime = async (bundle, target) => {
  const release = NODE_RUNTIME_RELEASES[target];
  if (!release) {
    throw new Error(`Missing pinned Node runtime for ${target}.`);
  }
  const archivePath = await ensurePinnedNodeRuntimeArchive(target);
  await extractNodeRuntime(archivePath, bundle, release.archive);
};

// The Daemon and the control CLI report the package version.
const stageReleaseGoBinaries = async (bundle, target, version) => {
  const [platform, releaseArch] = target.split("-");
  const goos = platform === "win32" ? "windows" : platform;
  const goarch = releaseArch === "x64" ? "amd64" : releaseArch;
  const build = async (output, ldflags, command) => {
    await mkdir(path.dirname(output), { recursive: true });
    await run("go", ["build", "-trimpath", ...ldflags, "-o", output, command], {
      cwd: path.join(repositoryRoot, "apps/computer/local-daemon"),
      env: { CGO_ENABLED: "0", GOARCH: goarch, GOOS: goos },
    });
    await chmod(output, 0o755);
  };
  const versioned = [
    "-ldflags",
    `-X github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport.ReleaseVersion=${version}`,
  ];
  await build(
    path.join(bundle, daemonEntry(target)),
    versioned,
    "./cmd/linger-computer-daemon",
  );
  await build(
    path.join(bundle, cliEntry(target)),
    versioned,
    "./cmd/linger-computer",
  );
  if (windows(target)) {
    await build(
      path.join(bundle, WINDOWS_LAUNCHER_ENTRY),
      [],
      "./cmd/linger-computer-launcher",
    );
  }
};

export const ensurePinnedNodeRuntimeArchive = async (target) => {
  return await ensureNodeRuntimeArchive(target, nodeRuntimeCacheDirectory());
};

const nodeRuntimeCacheDirectory = () =>
  process.env.LINGER_COMPUTER_NODE_DISTRIBUTION_CACHE?.trim() ||
  path.join(repositoryRoot, ".linger-runtime", "node-distributions");

export const extractNodeRuntime = async (archivePath, bundle, archiveName) => {
  if (archiveName.endsWith(".zip")) {
    return await extractWindowsNodeRuntime(archivePath, bundle, archiveName);
  }
  const distributionRoot = archiveName.replace(/\.tar\.gz$/u, "");
  const required = new Map([
    [
      `${distributionRoot}/bin/node`,
      { destination: path.join(bundle, "runtime/bin/node"), mode: 0o755 },
    ],
    [
      `${distributionRoot}/LICENSE`,
      { destination: path.join(bundle, "runtime/LICENSE"), mode: 0o644 },
    ],
  ]);
  const extracted = new Set();
  const unpack = tarStream.extract();
  unpack.on("entry", (header, entry, next) => {
    const output = required.get(header.name);
    if (!output) {
      entry.resume();
      entry.once("end", next);
      return;
    }
    if (header.type !== "file" || extracted.has(header.name)) {
      unpack.destroy(
        new Error(`Node runtime archive entry is invalid: ${header.name}.`),
      );
      return;
    }
    extracted.add(header.name);
    void (async () => {
      await mkdir(path.dirname(output.destination), { recursive: true });
      await pipeline(
        entry,
        createWriteStream(output.destination, {
          flags: "wx",
          mode: output.mode,
        }),
      );
      await chmod(output.destination, output.mode);
      next();
    })().catch((error) => unpack.destroy(error));
  });
  await pipeline(createReadStream(archivePath), createGunzip(), unpack);
  for (const requiredEntry of required.keys()) {
    if (!extracted.has(requiredEntry)) {
      throw new Error(`Node runtime archive is missing ${requiredEntry}.`);
    }
  }
};

// apps/computer/scripts/bundle.mjs also stages Windows development bundles.
const extractWindowsNodeRuntime = async (archivePath, bundle, archiveName) => {
  const yauzl = requireComputerBuildDependency("yauzl");
  const distributionRoot = archiveName.replace(/\.zip$/u, "");
  const required = new Map([
    [`${distributionRoot}/node.exe`, "runtime/bin/node.exe"],
    [`${distributionRoot}/LICENSE`, "runtime/LICENSE"],
  ]);
  const extracted = new Set();
  await new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, archive) => {
      if (error) return reject(error);
      const fail = (failure) => {
        archive.close();
        reject(failure);
      };
      archive.once("error", fail);
      archive.once("end", resolve);
      archive.on("entry", (entry) => {
        const destination = required.get(entry.fileName);
        if (!destination) return archive.readEntry();
        const mode = entry.externalFileAttributes >>> 16;
        if (extracted.has(entry.fileName) || (mode & 0o170000) === 0o120000) {
          return fail(
            new Error(
              `Node runtime archive entry is invalid: ${entry.fileName}.`,
            ),
          );
        }
        extracted.add(entry.fileName);
        archive.openReadStream(entry, (readError, stream) => {
          if (readError) return fail(readError);
          void (async () => {
            const output = path.join(bundle, destination);
            await mkdir(path.dirname(output), { recursive: true });
            await pipeline(
              stream,
              createWriteStream(output, { flags: "wx", mode: 0o755 }),
            );
            archive.readEntry();
          })().catch(fail);
        });
      });
      archive.readEntry();
    });
  });
  for (const requiredEntry of required.keys()) {
    if (!extracted.has(requiredEntry))
      throw new Error(`Node runtime archive is missing ${requiredEntry}.`);
  }
};

/** The CLI entries of the application archive, checked against their manifest. */
const validatedApplicationEntries = async (bundle) => {
  const manifest = JSON.parse(
    await readFile(path.join(bundle, "cli/teamhub-assets.json"), "utf8"),
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.entrypoint !== "teamhub.js" ||
    !Array.isArray(manifest.assets) ||
    !manifest.assets.every(
      (asset) =>
        asset &&
        typeof asset.path === "string" &&
        /^(?:teamhub\.js|teamhub-chunks\/[A-Za-z0-9_-]+\.js)$/u.test(
          asset.path,
        ) &&
        Number.isSafeInteger(asset.size_bytes) &&
        asset.size_bytes >= 0 &&
        typeof asset.sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(asset.sha256),
    ) ||
    !manifest.assets.some((asset) => asset.path === "teamhub.js") ||
    !manifest.assets.some((asset) =>
      asset.path.startsWith("teamhub-chunks/"),
    ) ||
    new Set(manifest.assets.map((asset) => asset.path)).size !==
      manifest.assets.length ||
    createHash("sha256")
      .update(JSON.stringify(manifest.assets))
      .digest("hex") !== manifest.artifact_sha256
  )
    throw new Error("Release CLI asset manifest is invalid.");
  for (const asset of manifest.assets) {
    const content = await readFile(path.join(bundle, "cli", asset.path));
    if (
      content.length !== asset.size_bytes ||
      createHash("sha256").update(content).digest("hex") !== asset.sha256
    )
      throw new Error(
        `Release CLI asset does not match its manifest: ${asset.path}`,
      );
  }
  return [
    ...RELEASE_APPLICATION_ENTRIES,
    "cli/teamhub-assets.json",
    // The Daemon derives its TeamHub command allow rules from this manifest;
    // without it every TeamHub command needs approval.
    "cli/teamhub-commands.json",
    ...manifest.assets
      .filter((asset) => asset.path !== "teamhub.js")
      .map((asset) => `cli/${asset.path}`),
  ];
};

const assertApplicationBundle = async (bundle, entries) => {
  const files = await listFiles(bundle);
  if (files.some((entry) => entry.includes("node_modules"))) {
    throw new Error("Release bundle contains unmanaged node_modules.");
  }
  for (const entry of entries) {
    if (!files.includes(entry)) {
      throw new Error(`Release bundle is missing ${entry}.`);
    }
    if (entry === "cli/teamhub-assets.json") continue;
    const encoded = (await readFile(path.join(bundle, entry))).toString("utf8");
    if (
      encoded.includes("@openai/codex") ||
      encoded.includes("/Users/") ||
      /vendor[/_-]?codex/iu.test(encoded)
    ) {
      throw new Error(`Release bundle contains forbidden content in ${entry}.`);
    }
  }
};

// Reproducible: sorted entries, fixed mtime and owner, normalized modes, and a
// gzip header without name or mtime and a fixed OS byte.
const createDeterministicArchive = async (bundle, entries, archivePath) => {
  const pack = tarStream.pack();
  const sorted = [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  let header = true;
  const fixedOsByte = new Transform({
    transform(chunk, _encoding, callback) {
      if (header) {
        // RFC 1952 byte 9 is the OS; zlib writes the build host's.
        if (chunk.length < 10) {
          callback(new Error("gzip header arrived split"));
          return;
        }
        chunk[9] = 3;
        header = false;
      }
      callback(null, chunk);
    },
  });
  const written = pipeline(
    pack,
    createGzip({ level: GZIP_LEVEL }),
    fixedOsByte,
    createWriteStream(archivePath, { flags: "wx", mode: 0o644 }),
  );
  for (const [name, source] of sorted) {
    const file = path.join(bundle, source);
    const content = await readFile(file);
    const mode = (await stat(file)).mode & 0o111 ? 0o755 : 0o644;
    await new Promise((resolve, reject) => {
      pack.entry(
        {
          gid: 0,
          gname: "",
          mode,
          mtime: RELEASE_TIMESTAMP,
          name,
          size: content.length,
          type: "file",
          uid: 0,
          uname: "",
        },
        content,
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  await written;
};

/** Builds `<prefix>-<sha256>.tar.gz` in the temporary staging directory. */
const stageArchive = async (bundle, entries, stagingDirectory, prefix) => {
  await mkdir(stagingDirectory, { recursive: true });
  const pending = path.join(stagingDirectory, `${prefix}.tmp`);
  await createDeterministicArchive(bundle, entries, pending);
  const digest = await sha256(pending);
  const file = `${prefix}-${digest}.tar.gz`;
  const size = (await stat(pending)).size;
  await rename(pending, path.join(stagingDirectory, file));
  return { file, sha256: digest, size };
};

// Publishes only after every target built, so a failure leaves no partial set.
const publishArchives = async (archives, stagingDirectory, filesDirectory) => {
  for (const { file } of archives) {
    await cp(
      path.join(stagingDirectory, file),
      path.join(filesDirectory, file),
    );
  }
};

const listFiles = async (root, relative = "") => {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release bundle contains symbolic link ${child}.`);
    }
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Release bundle contains unsupported entry ${child}.`);
  }
  return files.map((entry) => entry.split(path.sep).join("/")).sort();
};

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function run(command, arguments_, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, HUSKY: "0", ...options.env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? String(code)}).`));
    });
  });
}

async function runCapture(command, arguments_) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${command} failed (${signal ?? String(code)}).`));
    });
  });
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const result = await prepareLocalComputerRelease(process.argv.slice(2));
  process.stdout.write(
    result.release
      ? `Prepared Computer release ${result.release.version} in ${result.output}\n`
      : `Prepared Computer dependency archives in ${result.output}/files\n`,
  );
}
