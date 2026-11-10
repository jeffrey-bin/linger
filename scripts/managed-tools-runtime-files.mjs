import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const MANAGED_TOOLS_RUNTIME_FILES = [
  "managed-tools-runtime.mjs",
  "managed-tools-install.mjs",
  "managed-tools-launchers.mjs",
  "managed-tools-archive.mjs",
  "managed-tools-lock.mjs",
  "local-computer-node-distributions.mjs",
];

// Preserve module entrypoint guards: bundling the Node distribution script
// would also execute its download CLI when the Runtime adapter starts.
export async function stageManagedToolsRuntime(outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  for (const name of MANAGED_TOOLS_RUNTIME_FILES) {
    await copyFile(
      new URL(name, import.meta.url),
      path.join(outputDirectory, name),
    );
  }
}
