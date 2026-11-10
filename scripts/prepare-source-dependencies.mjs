import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { capture, resolveSourceRef } from "./prepare-source-archive.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// The hosts the desktop installs native source on.
export const DEPENDENCY_TARGETS = Object.freeze([
  "darwin-arm64",
  "linux-x64",
  "win32-x64",
]);

/**
 * The desktop downloads this archive beside the source package and unpacks
 * its single `pnpm-store/` folder into the checkout, so the native install
 * of the services needs no package registry. It holds the store of exactly
 * the projects scripts/source-native.mjs installs for one platform. Built on
 * that platform, the store also keeps the compiled native modules; built for
 * another one, it skips install scripts and the user's install compiles or
 * downloads those modules.
 */
export function parseSourceDependenciesArguments(arguments_) {
  const options = {
    label: null,
    name: "linger",
    output: path.join(repositoryRoot, ".linger-runtime/source-archive"),
    ref: "HEAD",
    target: `${process.platform}-${process.arch}`,
    "url-base": null,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (
      ![
        "--label",
        "--name",
        "--output",
        "--ref",
        "--target",
        "--url-base",
      ].includes(argument)
    ) {
      throw new Error(`Unknown source dependencies argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  for (const key of ["name", "label"]) {
    if (options[key] !== null && !/^[A-Za-z0-9][\w.-]*$/.test(options[key])) {
      throw new Error(`--${key} must be a plain file name: ${options[key]}`);
    }
  }
  if (!DEPENDENCY_TARGETS.includes(options.target)) {
    throw new Error(
      `--target must be one of ${DEPENDENCY_TARGETS.join(", ")}: ${options.target}`,
    );
  }
  const urlBase = options["url-base"];
  if (urlBase !== null && new URL(urlBase).protocol !== "https:") {
    throw new Error(`--url-base must be https: ${urlBase}`);
  }
  return {
    label: options.label,
    name: options.name,
    output: path.resolve(repositoryRoot, options.output),
    ref: options.ref,
    target: options.target,
    urlBase,
  };
}

export async function prepareSourceDependencies(
  arguments_,
  { cwd = repositoryRoot, pnpm = "pnpm" } = {},
) {
  const options = parseSourceDependenciesArguments(arguments_);
  const { commit, label } = await resolveSourceRef(
    options.ref,
    options.label,
    cwd,
  );
  const fileName = `${options.name}-${label}-dependencies-${options.target}.tar.gz`;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "source-dependencies-"));
  try {
    const tree = path.join(scratch, "tree");
    const store = path.join(scratch, "pnpm-store");
    await mkdir(tree);
    await run("sh", [
      "-c",
      'git -C "$0" archive --format=tar "$1" | tar -xf - -C "$2"',
      cwd,
      commit,
      tree,
    ]);
    // The store must come from the pnpm version the source pins.
    const pinned = JSON.parse(
      await readFile(path.join(tree, "package.json"), "utf8"),
    ).packageManager?.replace(/^pnpm@/, "");
    const version = (await capture(pnpm, ["--version"], { cwd: tree })).trim();
    if (version !== pinned) {
      throw new Error(
        `The source pins pnpm ${pinned}, but ${pnpm} is ${version}.`,
      );
    }
    const native = options.target === `${process.platform}-${process.arch}`;
    if (!native) {
      const [platform, cpu] = options.target.split("-");
      await appendFile(
        path.join(tree, "pnpm-workspace.yaml"),
        `\nsupportedArchitectures:\n  os: [${platform}]\n  cpu: [${cpu}]\n`,
      );
    }
    // The packed source decides which projects its install needs.
    const { NATIVE_SERVICE_PROJECTS, pnpmInstallArguments } = await import(
      pathToFileURL(path.join(tree, "scripts/source-native.mjs")).href
    );
    await run(
      pnpm,
      [
        ...pnpmInstallArguments(NATIVE_SERVICE_PROJECTS, store),
        ...(native ? [] : ["--ignore-scripts"]),
      ],
      { cwd: tree },
    );
    await mkdir(options.output, { recursive: true });
    const archive = path.join(options.output, fileName);
    const partial = `${archive}.partial`;
    try {
      await run("tar", ["-czf", partial, "-C", scratch, "pnpm-store"]);
      await rename(partial, archive);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    await writeFile(`${archive}.sha256`, `${sha256}  ${fileName}\n`);
    const result = {
      archive,
      bytes: (await stat(archive)).size,
      commit,
      sha256,
      target: options.target,
      // Whether the store holds compiled native modules.
      scripts: native,
      ...(options.urlBase && {
        url: new URL(fileName, options.urlBase.replace(/\/?$/, "/")).href,
      }),
    };
    await writeFile(
      path.join(options.output, `source-dependencies-${options.target}.json`),
      `${JSON.stringify({ ...result, archive: fileName }, null, 2)}\n`,
    );
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Reads the manifest for `LINGER_SOURCE_DEPENDENCIES_URL`/`_SHA256`. */
export async function sourceDependenciesEnvironment(output, target) {
  const manifest = JSON.parse(
    await readFile(
      path.join(output, `source-dependencies-${target}.json`),
      "utf8",
    ),
  );
  if (!manifest.url)
    throw new Error(`source-dependencies-${target}.json has no url`);
  return {
    LINGER_SOURCE_DEPENDENCIES_URL: manifest.url,
    LINGER_SOURCE_DEPENDENCIES_SHA256: manifest.sha256,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // Progress goes to stderr; stdout carries only the result.
    const child = spawn(command, args, { ...options, stdio: ["ignore", 2, 2] });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args[0]} exited with ${code}`)),
    );
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepareSourceDependencies(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`,
      );
      process.exitCode = 1;
    },
  );
}
