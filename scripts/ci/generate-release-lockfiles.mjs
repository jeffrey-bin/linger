#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { format, resolveConfig } from "prettier";
import { parse, stringify } from "yaml";

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

// The Computer release built into the node-services image installs
// from its own pruned lockfile, so a root lock change outside its closure keeps
// the Computer build stages cached. Every other image uses the root lockfile.
export const computerRoots = ["apps/computer", "apps/teamhub-cli"];

function dependencyReference(value) {
  return typeof value === "string" ? value : value?.version;
}

function dependenciesOf(snapshot) {
  return dependencyFields.flatMap((field) =>
    Object.entries(snapshot?.[field] ?? {}),
  );
}

function externalDependencyPath(name, reference) {
  if (reference.startsWith("link:")) return undefined;
  if (reference.startsWith("runtime:")) return reference;
  if (reference.startsWith("@")) return reference;

  const at = reference.indexOf("@");
  const colon = reference.indexOf(":");
  const bracket = reference.indexOf("(");
  if (
    at !== -1 &&
    (colon === -1 || at < colon) &&
    (bracket === -1 || at < bracket)
  ) {
    return reference;
  }
  return `${name}@${reference}`;
}

function workspaceImporter(importerId, reference) {
  return path.posix.normalize(
    path.posix.join(importerId, reference.slice("link:".length)),
  );
}

function packageKeyForSnapshot(lockfile, dependencyPath) {
  if (lockfile.packages?.[dependencyPath]) return dependencyPath;
  const peerSuffix = dependencyPath.indexOf("(");
  const base =
    peerSuffix === -1 ? dependencyPath : dependencyPath.slice(0, peerSuffix);
  if (lockfile.packages?.[base]) return base;
  throw new Error(`Lockfile package is missing for ${dependencyPath}`);
}

function collectImporters(lockfile, roots) {
  const selected = new Set();
  const pending = [...roots];

  while (pending.length > 0) {
    const importerId = pending.shift();
    if (selected.has(importerId)) continue;
    const importer = lockfile.importers?.[importerId];
    if (!importer)
      throw new Error(`Lockfile importer is missing: ${importerId}`);
    selected.add(importerId);

    for (const [, value] of dependenciesOf(importer)) {
      const reference = dependencyReference(value);
      if (!reference?.startsWith("link:")) continue;
      const dependencyImporter = workspaceImporter(importerId, reference);
      if (!lockfile.importers[dependencyImporter]) {
        throw new Error(
          `Workspace dependency ${dependencyImporter} referenced by ${importerId} is missing`,
        );
      }
      pending.push(dependencyImporter);
    }
  }

  return selected;
}

export function filterReleaseLockfile(lockfile, roots) {
  const supportedKeys = new Set([
    "lockfileVersion",
    "settings",
    "overrides",
    "packageExtensionsChecksum",
    "patchedDependencies",
    "importers",
    "packages",
    "snapshots",
  ]);
  const unsupported = Object.keys(lockfile).filter(
    (key) => !supportedKeys.has(key),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported pnpm lockfile sections: ${unsupported.join(", ")}`,
    );
  }

  const importerIds = collectImporters(lockfile, roots);
  const selectedSnapshots = new Set();
  const selectedPackages = new Set();
  const pending = [];

  for (const importerId of importerIds) {
    for (const [name, value] of dependenciesOf(
      lockfile.importers[importerId],
    )) {
      const reference = dependencyReference(value);
      if (reference) pending.push([name, reference, importerId]);
    }
  }

  while (pending.length > 0) {
    const [name, reference, parent] = pending.shift();
    const dependencyPath = externalDependencyPath(name, reference);
    if (!dependencyPath || selectedSnapshots.has(dependencyPath)) continue;
    const snapshot = lockfile.snapshots?.[dependencyPath];
    if (!snapshot) {
      throw new Error(
        `Lockfile snapshot ${dependencyPath} referenced by ${parent} is missing`,
      );
    }

    selectedSnapshots.add(dependencyPath);
    selectedPackages.add(packageKeyForSnapshot(lockfile, dependencyPath));
    for (const [childName, childReference] of dependenciesOf(snapshot)) {
      pending.push([childName, childReference, dependencyPath]);
    }
  }

  return {
    lockfileVersion: lockfile.lockfileVersion,
    settings: lockfile.settings,
    ...(lockfile.overrides ? { overrides: lockfile.overrides } : {}),
    ...(lockfile.packageExtensionsChecksum !== undefined
      ? { packageExtensionsChecksum: lockfile.packageExtensionsChecksum }
      : {}),
    ...(lockfile.patchedDependencies
      ? { patchedDependencies: lockfile.patchedDependencies }
      : {}),
    importers: {
      ".": {},
      ...Object.fromEntries(
        Object.entries(lockfile.importers).filter(([key]) =>
          importerIds.has(key),
        ),
      ),
    },
    packages: Object.fromEntries(
      Object.entries(lockfile.packages ?? {}).filter(([key]) =>
        selectedPackages.has(key),
      ),
    ),
    snapshots: Object.fromEntries(
      Object.entries(lockfile.snapshots ?? {}).filter(([key]) =>
        selectedSnapshots.has(key),
      ),
    ),
  };
}

export function renderReleaseLockfile(lockfile, roots) {
  const filtered = filterReleaseLockfile(lockfile, roots);
  return [
    "# Generated by scripts/ci/generate-release-lockfiles.mjs. Do not edit.",
    stringify(filtered, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
}

async function main() {
  const repositoryRoot = process.cwd();
  const source = await readFile(
    path.join(repositoryRoot, "pnpm-lock.yaml"),
    "utf8",
  );
  const outputPath = path.join(
    repositoryRoot,
    "apps/node-services/release-lockfiles/computer.yaml",
  );
  const expected = await format(
    renderReleaseLockfile(parse(source), computerRoots),
    { ...(await resolveConfig(outputPath)), filepath: outputPath },
  );
  if (!process.argv.includes("--check")) {
    await writeFile(outputPath, expected);
    return;
  }
  const actual = await readFile(outputPath, "utf8").catch(() => "");
  if (actual !== expected) {
    throw new Error(
      "apps/node-services/release-lockfiles/computer.yaml is stale. Run pnpm release-lockfiles:generate.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
