import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rmdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractManagedToolsArchive,
  relativeArchivePath,
  sha256,
  verifyManagedPackage,
} from "./managed-tools-archive.mjs";
import { acquireManagedToolsLock } from "./managed-tools-lock.mjs";
import { NODE_RUNTIME_VERSION } from "./local-computer-node-distributions.mjs";
import { writeManagedToolsLaunchers } from "./managed-tools-launchers.mjs";

const tools = ["teamhub", "lev8"];
async function collectChildren(pid, descendants) {
  if (!pid) return;
  if (process.platform === "darwin") {
    const snapshot = await new Promise((resolve) => {
      execFile(
        "/bin/ps",
        ["-A", "-o", "pid=,ppid="],
        { timeout: 150, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
        (error, stdout) => resolve(error ? "" : stdout),
      );
    });
    const childrenByParent = new Map();
    for (const line of snapshot.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (!match) continue;
      const childPid = Number(match[1]);
      const parentPid = Number(match[2]);
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(childPid);
      childrenByParent.set(parentPid, children);
    }
    const pending = [pid];
    while (pending.length > 0) {
      for (const childPid of childrenByParent.get(pending.pop()) ?? []) {
        if (childPid === pid || descendants.has(childPid)) continue;
        descendants.add(childPid);
        pending.push(childPid);
      }
    }
    return;
  }
  if (process.platform !== "linux") return;
  const children = await readFile(
    `/proc/${pid}/task/${pid}/children`,
    "utf8",
  ).catch(() => "");
  for (const childPid of children
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number)) {
    if (descendants.has(childPid)) continue;
    descendants.add(childPid);
    await collectChildren(childPid, descendants);
  }
}
function commandOutput(command, arguments_, cwd, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const descendants = new Set();
    let timedOut = false;
    let terminated = false;
    let settled = false;
    const output = {
      stdout: { chunks: [], size: 0 },
      stderr: { chunks: [], size: 0 },
    };
    const captured = () =>
      Object.fromEntries(
        Object.entries(output).map(([name, value]) => [
          name,
          Buffer.concat(value.chunks).toString("utf8"),
        ]),
      );
    const outputLimit = 1024 * 1024;
    const kill = (signal) => {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Fall back to terminating the direct child. */
        }
      }
      for (const pid of descendants) {
        try {
          process.kill(pid, signal);
        } catch {
          /* Already stopped. */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* The deadline still settles. */
      }
    };
    // execFile does not forward detached to spawn. A real owned group is
    // necessary to terminate descendants on platforms without /proc.
    const child = spawn(command, arguments_, {
      cwd,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanup = () => {
      child.removeListener("error", failed);
      child.removeListener("close", closed);
      child.stdout.removeListener("data", stdoutData);
      child.stderr.removeListener("data", stderrData);
    };
    const failed = (error) => {
      if (settled || timedOut) return;
      settled = true;
      clearTimeout(deadline);
      kill("SIGKILL");
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(Object.assign(error, captured()));
    };
    const closed = (code, signal) => {
      if (settled || timedOut) return;
      if (code !== 0) {
        failed(
          Object.assign(new Error(`Command failed: ${command}`), {
            code,
            signal,
          }),
        );
        return;
      }
      settled = true;
      clearTimeout(deadline);
      cleanup();
      const { stdout, stderr } = captured();
      resolve(`${stdout}${stderr}`.trim());
    };
    const append = (stream, chunk) => {
      const value = output[stream];
      if (value.size + chunk.length > outputLimit) {
        failed(
          Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        );
        return;
      }
      value.chunks.push(chunk);
      value.size += chunk.length;
    };
    const stdoutData = (chunk) => append("stdout", chunk);
    const stderrData = (chunk) => append("stderr", chunk);
    child.once("error", failed);
    child.once("close", closed);
    child.stdout.on("data", stdoutData);
    child.stderr.on("data", stderrData);
    const deadline = setTimeout(() => {
      timedOut = true;
      // Some sandboxes cannot create the requested process group. Capture the
      // owned descendants before TERM lets their parent exit and orphan them.
      void collectChildren(child.pid, descendants).finally(() => {
        if (!terminated) kill("SIGTERM");
      });
      setTimeout(() => {
        terminated = true;
        kill("SIGKILL");
        settled = true;
        cleanup();
        // Escaped descendants must not keep our pipe handles or lock alive.
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(
          Object.assign(
            new Error(`Command timed out after ${timeoutMs}ms: ${command}`),
            { ...captured(), killed: true, signal: "SIGKILL" },
          ),
        );
      }, 250);
    }, timeoutMs);
  });
}

function unmanaged(message) {
  return Object.assign(new Error(message), { code: "UNMANAGED_LAYOUT" });
}

export async function detectManagedToolsPlatform(probe = commandOutput) {
  const system = (await probe("uname", ["-s"])).trim();
  const machine = (await probe("uname", ["-m"])).trim();
  const osName = { Linux: "linux", Darwin: "darwin" }[system];
  let architecture = {
    x86_64: "amd64",
    amd64: "amd64",
    aarch64: "arm64",
    arm64: "arm64",
  }[machine];
  if (!osName || !architecture)
    throw new Error(`Unsupported platform: ${system}/${machine}`);
  if (osName === "darwin") {
    const version = (await probe("sw_vers", ["-productVersion"])).trim();
    if (
      !/^\d+\.\d+(?:\.\d+)?$/u.test(version) ||
      Number(version.split(".")[0]) < 13
    )
      throw new Error(`macOS 13 or newer is required (found ${version})`);
    let translated = "0";
    try {
      translated = (
        await probe("sysctl", ["-n", "sysctl.proc_translated"])
      ).trim();
    } catch {
      /* Native Intel Macs may not expose this sysctl. */
    }
    if (translated === "1") architecture = "arm64";
  } else {
    let libc;
    try {
      libc = await probe("ldd", ["--version"]);
    } catch (error) {
      if (/musl/iu.test(`${error.stdout ?? ""}${error.stderr ?? ""}`))
        throw new Error("Unsupported musl libc; Linux requires glibc >= 2.31", {
          cause: error,
        });
      throw new Error("Linux requires glibc >= 2.31; libc detection failed", {
        cause: error,
      });
    }
    if (/musl/iu.test(libc))
      throw new Error("Unsupported musl libc; Linux requires glibc >= 2.31");
    const version =
      /(?:glibc|GNU libc|GNU C Library|GLIBC)[^\n]*?\b(\d+)\.(\d+)\b/iu.exec(
        libc,
      );
    if (
      !version ||
      Number(version[1]) < 2 ||
      (Number(version[1]) === 2 && Number(version[2]) < 31)
    )
      throw new Error("Linux requires glibc >= 2.31");
  }
  return `${osName}-${architecture}`;
}

function releaseId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) ||
    value === "stable"
  )
    throw new Error("A fixed release-id is required");
  return value;
}

export function createManagedToolsInstaller({
  root = process.env.LINGER_TOOLS_ROOT ??
    path.join(os.homedir(), ".local/share/simplexai/tools"),
  baseUrl = process.env.LINGER_CLI_RELEASES_BASE_URL,
  detectPlatform = detectManagedToolsPlatform,
  lockTimeoutMs = 30_000,
  smokeTimeoutMs = 15_000,
  onSwitch,
  requiredLev8Version,
} = {}) {
  root = path.resolve(root);
  if (!Number.isSafeInteger(smokeTimeoutMs) || smokeTimeoutMs < 1)
    throw new Error("Invalid smoke timeout");
  const location = (name) => path.join(root, name);
  const journalPath = location(".transaction.json");

  async function atomicJson(filename, value) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function pointer(slot, target) {
    if (target === null) {
      await rm(location(slot), { force: true });
      return;
    }
    const temporary = location(`.${slot}.${randomUUID()}.tmp`);
    try {
      await symlink(target, temporary);
      await rename(temporary, location(slot));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function readPointer(slot) {
    let target;
    try {
      target = await readlink(location(slot));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!/^releases\/[0-9a-f-]{36}$/u.test(target))
      throw unmanaged(`Unmanaged ${slot} pointer`);
    await validateTarget(target);
    return target;
  }
  async function validateTarget(target) {
    if (!/^releases\/[0-9a-f-]{36}$/u.test(target))
      throw unmanaged("Invalid managed release path");
    for (const filename of [
      location(target),
      path.join(location(target), ".release.json"),
    ]) {
      const entry = await lstat(filename).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (
        entry?.isSymbolicLink() ||
        (filename === location(target) && entry && !entry.isDirectory())
      )
        throw unmanaged(
          "Managed release paths must not be symlinks or non-directories",
        );
    }
  }
  async function snapshot(target) {
    if (target === null) return null;
    await validateTarget(target);
    const metadata = JSON.parse(
      await readFile(path.join(location(target), ".release.json"), "utf8"),
    );
    releaseId(metadata.releaseId);
    if (
      !/^(?:linux|darwin)-(?:amd64|arm64)$/u.test(metadata.platform) ||
      tools.some(
        (tool) =>
          typeof metadata.versions?.[tool] !== "string" ||
          !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(
            metadata.versions[tool],
          ),
      )
    )
      throw new Error("Invalid managed release metadata");
    return { ...metadata, directory: location(target) };
  }
  async function state() {
    const result = { current: null, previous: null };
    const corrupt = {};
    for (const slot of ["current", "previous"]) {
      const target = await readPointer(slot);
      try {
        result[slot] = await snapshot(target);
      } catch (error) {
        if (error.code === "UNMANAGED_LAYOUT") throw error;
        corrupt[slot] = error.message;
      }
    }
    if (Object.keys(corrupt).length) result.corrupt = corrupt;
    return result;
  }
  async function recover() {
    let journal;
    try {
      journal = JSON.parse(await readFile(journalPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (journal.schema !== 1 || !journal.current)
      throw new Error("Invalid managed installation transaction");
    await snapshot(journal.current);
    await snapshot(journal.previous);
    await pointer("current", journal.current);
    await pointer("previous", journal.previous);
    await rm(journalPath);
  }
  async function locked(action) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory())
      throw unmanaged("Managed installation root must not be a symlink");
    for (const directory of ["releases", ".staging", ".locks"]) {
      await mkdir(location(directory), { recursive: true, mode: 0o700 });
      if (!(await lstat(location(directory))).isDirectory())
        throw new Error("Managed installation directory must not be a symlink");
    }
    const unlock = await acquireManagedToolsLock(root, lockTimeoutMs);
    try {
      await recover();
      for (const abandoned of await readdir(location(".staging")))
        await rm(path.join(location(".staging"), abandoned), {
          recursive: true,
          force: true,
        });
      for (const abandoned of await readdir(root))
        if (
          /^\.(?:current|previous|transaction\.json)\.[0-9a-f-]{36}\.tmp$/u.test(
            abandoned,
          )
        )
          await rm(location(abandoned), { force: true });
      return await action();
    } finally {
      await unlock();
    }
  }
  async function readSource(relative) {
    if (!baseUrl)
      throw new Error("Configure LINGER_CLI_RELEASES_BASE_URL or baseUrl");
    relative = relativeArchivePath(relative);
    if (baseUrl.startsWith("file://"))
      return readFile(path.join(fileURLToPath(baseUrl), relative));
    if (!/^[a-z][a-z0-9+.-]*:/iu.test(baseUrl))
      return readFile(path.join(path.resolve(baseUrl), relative));
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    if (base.protocol !== "https:")
      throw new Error(
        "Release source must be HTTPS, file:// or a local directory",
      );
    const url = new URL(relative, base);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error("Artifact path escapes configured release source");
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(`Release download failed (HTTP ${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  async function manifestFor(id, platform) {
    const manifest = JSON.parse(
      (await readSource(`cli/manifests/${id}.json`)).toString("utf8"),
    );
    if (
      manifest.schema !== 1 ||
      manifest.release_id !== id ||
      manifest.node?.version !== NODE_RUNTIME_VERSION ||
      process.versions.node !== NODE_RUNTIME_VERSION
    )
      throw new Error("Invalid release manifest or incompatible Node version");
    for (const tool of tools) {
      const entry = manifest.tools?.[tool];
      if (
        !entry ||
        typeof entry.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(entry.version)
      )
        throw new Error(`Invalid release manifest for ${tool}`);
      const artifact = entry.artifacts?.[platform];
      if (!artifact)
        throw new Error(`Unsupported platform ${platform} for ${tool}`);
      if (
        !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.size) ||
        artifact.size <= 0
      )
        throw new Error(`Invalid release manifest artifact for ${tool}`);
      relativeArchivePath(artifact.path);
    }
    return manifest;
  }
  async function smoke(directory, versions) {
    for (const tool of tools) {
      const entry = await lstat(path.join(directory, "bin", tool));
      if (!entry.isFile() || (entry.mode & 0o111) === 0)
        throw new Error("Managed Runtime launcher is unavailable");
    }
    for (const tool of tools) {
      const packageRoot = path.join(directory, tool);
      if (!(await lstat(packageRoot)).isDirectory())
        throw unmanaged("Managed package root must be a directory");
      await verifyManagedPackage(packageRoot, tool);
      const binary = path.join(packageRoot, tool);
      let output;
      try {
        await lstat(binary);
        output = await commandOutput(
          binary,
          ["--version"],
          packageRoot,
          smokeTimeoutMs,
        );
      } catch (error) {
        if (error.code !== "ENOENT" || tool !== "teamhub") throw error;
        output = await commandOutput(
          process.execPath,
          [path.join(packageRoot, "teamhub.js"), "--version"],
          packageRoot,
          smokeTimeoutMs,
        );
      }
      const escaped = versions[tool].replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      if (!new RegExp(`(?:^|[\\s:v])${escaped}(?=$|\\s)`, "u").test(output))
        throw new Error(
          `${tool} --version smoke mismatch (expected ${versions[tool]})`,
        );
    }
  }
  async function verified(target) {
    try {
      const existing = await snapshot(target);
      if (existing) await smoke(existing.directory, existing.versions);
      return existing;
    } catch (error) {
      if (error.code === "UNMANAGED_LAYOUT") throw error;
      return null; // Missing or corrupt managed data can be reinstalled.
    }
  }
  async function readCurrent() {
    // Execution only reads an atomic pointer to a retained release directory.
    // Installation, repair and transaction recovery still belong to the lock.
    for (const directory of [root, location("releases")]) {
      const entry = await lstat(directory).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!entry) return null;
      if (!entry.isDirectory())
        throw unmanaged("Managed installation directory must not be a symlink");
    }
    if (process.versions.node !== NODE_RUNTIME_VERSION)
      throw new Error(`Managed tools require Node ${NODE_RUNTIME_VERSION}`);
    const current = await verified(await readPointer("current"));
    if (
      current &&
      current.platform === (await detectPlatform()) &&
      (!requiredLev8Version || current.versions.lev8 === requiredLev8Version)
    )
      return current;
    return null;
  }
  async function switchTo(current, previous) {
    await atomicJson(journalPath, { schema: 1, current, previous });
    await onSwitch?.("prepared");
    await pointer("current", current);
    await onSwitch?.("current");
    await pointer("previous", previous);
    await onSwitch?.("previous");
    await rm(journalPath);
    return state();
  }
  async function install(id, ensure, useCurrent = false) {
    releaseId(id);
    return locked(async () => {
      const platform = await detectPlatform();
      if (process.versions.node !== NODE_RUNTIME_VERSION)
        throw new Error(`Managed tools require Node ${NODE_RUNTIME_VERSION}`);
      const current = await readPointer("current");
      const previous = await readPointer("previous");
      if (useCurrent) {
        try {
          const selected = await snapshot(current);
          if (selected) id = selected.releaseId;
        } catch (error) {
          if (error.code === "UNMANAGED_LAYOUT") throw error;
          // Corrupt metadata cannot select a release; use the configured fallback.
        }
      }
      const existing = await verified(current);
      if (
        ensure &&
        existing?.releaseId === id &&
        existing.platform === platform &&
        (!requiredLev8Version || existing.versions.lev8 === requiredLev8Version)
      )
        return state();
      const fallback = existing
        ? current
        : (await verified(previous))
          ? previous
          : null;
      const manifest = await manifestFor(id, platform);
      if (
        requiredLev8Version &&
        manifest.tools.lev8.version !== requiredLev8Version
      )
        throw new Error(`Managed release requires lev8 ${requiredLev8Version}`);
      const identity = randomUUID();
      const staged = location(`.staging/${identity}`);
      await mkdir(staged, { mode: 0o700 });
      try {
        const versions = {};
        for (const tool of tools) {
          const entry = manifest.tools[tool];
          const artifact = entry.artifacts[platform];
          const archive = await readSource(artifact.path);
          if (archive.length !== artifact.size)
            throw new Error(`${tool} archive size mismatch`);
          if (sha256(archive) !== artifact.sha256)
            throw new Error(`${tool} archive SHA256 mismatch`);
          await extractManagedToolsArchive(archive, path.join(staged, tool));
          // Historic lev8 archives wrap the executable in one top-level directory.
          const children = await readdir(path.join(staged, tool), {
            withFileTypes: true,
          });
          if (children.length === 1 && children[0].isDirectory()) {
            const wrapped = path.join(staged, tool, children[0].name);
            await rename(wrapped, path.join(staged, `.${tool}`));
            await rmdir(path.join(staged, tool));
            await rename(
              path.join(staged, `.${tool}`),
              path.join(staged, tool),
            );
          }
          versions[tool] = entry.version;
        }
        await writeManagedToolsLaunchers(path.join(staged, "bin"), {
          root,
          baseUrl,
          releaseId: id,
          requiredLev8Version,
        });
        await smoke(staged, versions);
        await atomicJson(path.join(staged, ".release.json"), {
          releaseId: id,
          platform,
          versions,
        });
        const target = `releases/${identity}`;
        await rename(staged, location(target));
        return await switchTo(target, fallback);
      } finally {
        await rm(staged, { recursive: true, force: true });
      }
    });
  }
  return {
    readCurrent,
    ensure: (id) => install(id, true),
    ensureCurrent: (fallbackId) => install(fallbackId, true, true),
    update: (id) => install(id, false),
    status: () => locked(state),
    rollback: () =>
      locked(async () => {
        const previous = await readPointer("previous");
        const candidate = await snapshot(previous);
        if (!candidate)
          throw new Error("No previous managed release to roll back to");
        if (candidate.platform !== (await detectPlatform()))
          throw new Error("Previous release platform does not match this host");
        await smoke(candidate.directory, candidate.versions);
        const current = await readPointer("current");
        return switchTo(previous, (await verified(current)) ? current : null);
      }),
  };
}
