import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

// The TeamHub commands Native runs. A desktop build compiles them from the
// source package it ships (apps/desktop/scripts/build-teamhub.mjs), so Native
// there needs no Go toolchain, module download or compile.
export const TEAMHUB_COMMANDS = ["teamhub", "migrate", "account"] as const;
export type TeamhubCommand = (typeof TEAMHUB_COMMANDS)[number];
// Where a checkout keeps them; scripts/source-native.mjs runs them from here
// and compiles the commands itself when the folder is missing.
export const TEAMHUB_BINARY_DIRECTORY = ".simplexai-runtime/prebuilt";
export const TEAMHUB_BINARY_MANIFEST = "manifest.json";

export interface TeamhubBinary {
  file: string;
  sha256: string;
  bytes: number;
}
export interface TeamhubBinaries {
  target: string;
  sourceCommit: string;
  sourceArchiveSha256: string;
  goVersion: string;
  binaries: Record<TeamhubCommand, TeamhubBinary>;
}

export function parseTeamhubBinaries(value: unknown): TeamhubBinaries {
  const manifest = value as TeamhubBinaries;
  const valid =
    !!manifest &&
    typeof manifest === "object" &&
    typeof manifest.target === "string" &&
    /^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? "") &&
    /^[0-9a-f]{64}$/.test(manifest.sourceArchiveSha256 ?? "") &&
    typeof manifest.goVersion === "string" &&
    !!manifest.binaries &&
    TEAMHUB_COMMANDS.every((command) => {
      const binary = manifest.binaries[command];
      return (
        !!binary &&
        typeof binary.file === "string" &&
        /^[\w-]+(?:\.exe)?$/.test(binary.file) &&
        /^[0-9a-f]{64}$/.test(binary.sha256 ?? "") &&
        Number.isSafeInteger(binary.bytes) &&
        binary.bytes > 0
      );
    });
  if (!valid) throw new Error("Invalid TeamHub binary manifest.");
  return {
    target: manifest.target,
    sourceCommit: manifest.sourceCommit,
    sourceArchiveSha256: manifest.sourceArchiveSha256,
    goVersion: manifest.goVersion,
    binaries: Object.fromEntries(
      TEAMHUB_COMMANDS.map((command) => {
        const { file, sha256, bytes } = manifest.binaries[command];
        return [command, { file, sha256, bytes }];
      }),
    ) as Record<TeamhubCommand, TeamhubBinary>,
  };
}

// The manifest in `directory`, or undefined when there is none.
export async function readTeamhubBinaries(
  directory: string,
): Promise<TeamhubBinaries | undefined> {
  let text;
  try {
    text = await readFile(
      path.join(directory, TEAMHUB_BINARY_MANIFEST),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  return parseTeamhubBinaries(JSON.parse(text));
}

async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Throws unless every binary in `directory` has its manifest's size and sha256.
export async function verifyTeamhubBinaries(
  directory: string,
  manifest: TeamhubBinaries,
): Promise<void> {
  for (const command of TEAMHUB_COMMANDS) {
    const binary = manifest.binaries[command];
    const file = path.join(directory, binary.file);
    const size = await stat(file).then(
      (info) => info.size,
      () => -1,
    );
    if (size !== binary.bytes || (await digest(file)) !== binary.sha256)
      throw new Error(
        `${binary.file} does not match its TeamHub binary manifest.`,
      );
  }
}

// Copies the binaries a desktop build ships in `from` into the checkout it
// unpacked from the same source package. The manifest goes last, so a copy
// cut short leaves none and Native compiles instead.
export async function installTeamhubBinaries(
  from: string,
  repo: string,
  expected: { target: string; sourceArchiveSha256: string },
): Promise<"absent" | "current" | "installed"> {
  const manifest = await readTeamhubBinaries(from);
  if (!manifest) return "absent";
  if (manifest.target !== expected.target)
    throw new Error(
      `The bundled TeamHub binaries are for ${manifest.target}, not ${expected.target}.`,
    );
  if (manifest.sourceArchiveSha256 !== expected.sourceArchiveSha256)
    throw new Error(
      "The bundled TeamHub binaries were built from another source package.",
    );
  const destination = path.join(repo, TEAMHUB_BINARY_DIRECTORY);
  const current = await readTeamhubBinaries(destination).catch(() => undefined);
  if (JSON.stringify(current) === JSON.stringify(manifest)) return "current";
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  try {
    for (const command of TEAMHUB_COMMANDS) {
      const { file } = manifest.binaries[command];
      await copyFile(path.join(from, file), path.join(destination, file));
    }
    await verifyTeamhubBinaries(destination, manifest);
    const temporary = path.join(
      destination,
      `${TEAMHUB_BINARY_MANIFEST}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, JSON.stringify(manifest, null, 2));
    await rename(temporary, path.join(destination, TEAMHUB_BINARY_MANIFEST));
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return "installed";
}

// Whether the checkout has TeamHub binaries for this computer that verify.
// Ones that do not are removed, so the commands compile from source instead.
export async function checkTeamhubBinaries(
  repo: string,
  target = `${process.platform}-${process.arch}`,
): Promise<"absent" | "verified" | "removed"> {
  const directory = path.join(repo, TEAMHUB_BINARY_DIRECTORY);
  try {
    const manifest = await readTeamhubBinaries(directory);
    if (!manifest) return "absent";
    if (manifest.target !== target) throw new Error("another target");
    await verifyTeamhubBinaries(directory, manifest);
    return "verified";
  } catch {
    await rm(directory, { recursive: true, force: true });
    return "removed";
  }
}
