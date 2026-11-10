import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The line node-services replaces with this deployment's release metadata. */
export const WINDOWS_RELEASE_METADATA_MARKER =
  "__LINGER_RELEASE_METADATA_BASE64__";

/**
 * Writes the Windows install and uninstall entrypoints with the shared
 * bootstrap and the installer helper embedded. The release metadata stays a
 * marker: node-services renders it with its origin at startup.
 */
export const publishWindowsInstallers = async (releaseRoot) => {
  const helper = await readFile(
    path.join(repositoryRoot, "scripts/local-computer-windows-installer.mjs"),
    "utf8",
  );
  const common = await readFile(
    path.join(repositoryRoot, "scripts/local-computer-windows-bootstrap.ps1"),
    "utf8",
  );
  for (const [sourceName, outputName] of [
    ["install-linger-computer.ps1", "linger-computer.ps1"],
    ["uninstall-linger-computer.ps1", "uninstall-linger-computer.ps1"],
  ]) {
    const template = await readFile(
      path.join(repositoryRoot, "scripts", sourceName),
      "utf8",
    );
    const source = template
      // PowerShell regexes contain $'; do not interpret them as JS replacements.
      .replace("# LINGER_WINDOWS_BOOTSTRAP", () => common)
      .replace(
        "__LINGER_INSTALLER_HELPER_BASE64__",
        Buffer.from(helper).toString("base64"),
      );
    await atomicWrite(path.join(releaseRoot, outputName), source);
  }
};

/** Fills the marker the way node-services does, for tests that run them. */
export const renderWindowsInstaller = (template, metadata) =>
  template.replace(WINDOWS_RELEASE_METADATA_MARKER, () =>
    Buffer.from(JSON.stringify(metadata)).toString("base64"),
  );

const atomicWrite = async (destination, content) => {
  await mkdir(path.dirname(destination), { recursive: true });
  const pending = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    // node-services reads these as its unprivileged user.
    await writeFile(pending, content, { mode: 0o644, flag: "wx" });
    await rename(pending, destination);
  } finally {
    await rm(pending, { force: true });
  }
};
