import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
// Bind installation configuration outside the isolated Runtime environment.
// No token or API credential belongs in these owner-only launchers.
export async function writeManagedToolsLaunchers(directory, configuration) {
  const relative = path.relative(configuration.root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Runtime launchers must stay inside the managed root");
  let parent = configuration.root;
  for (const part of ["", ...relative.split(path.sep)]) {
    parent = path.join(parent, part);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!(await lstat(parent)).isDirectory())
      throw new Error("Managed Runtime directories must not be symlinks");
  }
  const entrypoint = fileURLToPath(
    new URL("./managed-tools-runtime.mjs", import.meta.url),
  );
  for (const tool of ["teamhub", "lev8"]) {
    const target = path.join(directory, tool);
    const marker = "# Linger managed CLI launcher\n";
    try {
      if (
        !(await lstat(target)).isFile() ||
        !(await readFile(target, "utf8")).startsWith("#!/bin/sh\n" + marker)
      )
        throw new Error("Refusing to replace an unmanaged Runtime launcher");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = path.join(directory, `.${tool}.${randomUUID()}.tmp`);
    try {
      await writeFile(
        temporary,
        `#!/bin/sh\n${marker}exec ${quote(process.execPath)} ${quote(entrypoint)} invoke ${quote(JSON.stringify(configuration))} ${tool} "$@"\n`,
        { mode: 0o700, flag: "wx" },
      );
      await rename(temporary, path.join(directory, tool));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
