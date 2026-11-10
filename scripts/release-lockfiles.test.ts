import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  computerRoots,
  filterReleaseLockfile,
  renderReleaseLockfile,
} from "./ci/generate-release-lockfiles.mjs";

const execFileAsync = promisify(execFile);
let parsedRootLockfile: Promise<ReturnType<typeof parse>> | undefined;

async function rootLockfile() {
  // The committed input is immutable during this suite; each mutation case
  // still owns its object graph. Keep the real generator CLI check separate.
  parsedRootLockfile ??= readFile("pnpm-lock.yaml", "utf8").then((source) =>
    parse(source),
  );
  return structuredClone(await parsedRootLockfile);
}

describe("Computer release lockfile", () => {
  // The check spawns node to regenerate the Computer lock from the root lock; on a
  // loaded CI host that exceeds vitest's 5s default. It asserts correctness, so the
  // budget only catches hangs.
  it("keeps the committed Computer lock generated from the root lock", async () => {
    await expect(
      execFileAsync("node", [
        "scripts/ci/generate-release-lockfiles.mjs",
        "--check",
      ]),
    ).resolves.toBeDefined();
  }, 60_000);

  it("keeps the Computer lock independent of other importers' dependencies", async () => {
    const lockfile = await rootLockfile();
    const before = renderReleaseLockfile(lockfile, computerRoots);
    delete lockfile.importers["apps/web"];
    delete lockfile.importers["apps/node-services"];
    expect(renderReleaseLockfile(lockfile, computerRoots)).toBe(before);
  });

  it("includes the workspace dependency closure and excludes other importers", async () => {
    const lockfile = await rootLockfile();
    const computer = filterReleaseLockfile(lockfile, computerRoots);

    expect(Object.keys(computer.importers)).toEqual([
      ".",
      "apps/computer",
      "apps/teamhub-cli",
      "contracts/generated/typescript",
      "packages/document-files",
      "packages/service-kit",
    ]);
    expect(Object.keys(computer.snapshots).length).toBeLessThan(
      Object.keys(lockfile.snapshots).length,
    );
  });

  it("keeps workspace patch metadata", async () => {
    const lockfile = await rootLockfile();
    const filtered = filterReleaseLockfile(lockfile, computerRoots);

    expect(filtered.overrides).toEqual(lockfile.overrides);
    expect(filtered.patchedDependencies).toEqual(lockfile.patchedDependencies);
  });

  it("preserves the package extension checksum", async () => {
    const lockfile = await rootLockfile();
    lockfile.packageExtensionsChecksum = "sha256-test-extensions";

    expect(
      filterReleaseLockfile(lockfile, computerRoots).packageExtensionsChecksum,
    ).toBe(lockfile.packageExtensionsChecksum);
    expect(
      parse(renderReleaseLockfile(lockfile, computerRoots))
        .packageExtensionsChecksum,
    ).toBe(lockfile.packageExtensionsChecksum);
  });

  it("does not add a checksum when the root lockfile has no extensions", async () => {
    const lockfile = await rootLockfile();
    delete lockfile.packageExtensionsChecksum;

    expect(filterReleaseLockfile(lockfile, computerRoots)).not.toHaveProperty(
      "packageExtensionsChecksum",
    );
  });

  it("still rejects unknown lockfile metadata", async () => {
    const lockfile = await rootLockfile();
    lockfile.unrecognizedMetadata = {};

    expect(() => filterReleaseLockfile(lockfile, computerRoots)).toThrow(
      "Unsupported pnpm lockfile sections: unrecognizedMetadata",
    );
  });

  it("pins the release root manifest to the repository Node and pnpm toolchain", async () => {
    const rootPackage = JSON.parse(await readFile("package.json", "utf8"));
    const releasePackage = JSON.parse(
      await readFile(
        "apps/node-services/release-lockfiles/package.json",
        "utf8",
      ),
    );

    expect(releasePackage).toEqual({
      name: "linger-release-build",
      private: true,
      packageManager: rootPackage.packageManager,
      engines: rootPackage.engines,
    });
  });

  it("includes a Computer dependency and its transitive snapshot", async () => {
    const lockfile = await rootLockfile();
    lockfile.importers["apps/computer"].dependencies.probe = {
      specifier: "1.0.0",
      version: "1.0.0",
    };
    lockfile.packages["probe@1.0.0"] = { resolution: { integrity: "probe" } };
    lockfile.packages["probe-child@2.0.0"] = {
      resolution: { integrity: "probe-child" },
    };
    lockfile.snapshots["probe@1.0.0"] = {
      dependencies: { "probe-child": "2.0.0" },
    };
    lockfile.snapshots["probe-child@2.0.0"] = {};

    const filtered = filterReleaseLockfile(lockfile, computerRoots);
    expect(filtered.snapshots).toHaveProperty("probe@1.0.0");
    expect(filtered.snapshots).toHaveProperty("probe-child@2.0.0");
    expect(filtered.packages).toHaveProperty("probe-child@2.0.0");
  });

  it("fails closed when a selected dependency snapshot is missing", async () => {
    const lockfile = await rootLockfile();
    lockfile.importers["apps/computer"].dependencies.missing = {
      specifier: "1.0.0",
      version: "1.0.0",
    };

    expect(() => filterReleaseLockfile(lockfile, computerRoots)).toThrow(
      "Lockfile snapshot missing@1.0.0",
    );
  });
});
