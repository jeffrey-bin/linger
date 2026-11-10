import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  realpath,
  readdir,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installNativeRuntime,
  inspectRuntime,
  runtimeEnvironmentFromDescriptors,
} from "./managed-runtimes.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const status = (runtime = "claude", ready = false) => ({
  schema: "localmodels.harness-status/v1",
  runtimes: [
    {
      runtime,
      executable: "/upstream/runtime",
      argvPrefix: [],
      installed: true,
      authenticated: ready,
      authMode: ready ? "oauth" : null,
      loginCommand: {
        executable: "/upstream/runtime",
        args: ["upstream-login"],
        env: {},
      },
    },
  ],
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "runtime-delegate-"));
  roots.push(home);
  return { home, signal: new AbortController().signal, onEvent: vi.fn() };
}
it("uses upstream status and OAuth descriptors without provider-specific probes", async () => {
  const options = await fixture();
  const localmodels = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify(status()),
    stderr: "",
  }));
  const value = await inspectRuntime("claude", options, { localmodels });
  expect(value).toMatchObject({
    installed: true,
    ready: false,
    executable: "/upstream/runtime",
    loginCommand: "'/upstream/runtime' 'upstream-login'",
  });
  expect(localmodels.mock.calls[0]?.slice(0, 2)).toEqual([
    options.home,
    [
      "harness",
      "status",
      "--root",
      path.join(options.home, "runtime", "harness"),
      "--runtime",
      "claude",
      "--json",
    ],
  ]);
});
it("approves the exact upstream install plan and delegates apply", async () => {
  const options = await fixture();
  const id = "a".repeat(64);
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan")
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id,
          runtime: "pi",
        }),
      );
    return {
      code: 0,
      stdout: args[1] === "status" ? JSON.stringify(status("pi", true)) : "",
      stderr: "",
    };
  });
  expect(
    await installNativeRuntime("pi", options, { localmodels }),
  ).toMatchObject({ state: "ready" });
  expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
    "plan",
    "apply",
    "status",
  ]);
  const apply = localmodels.mock.calls[1]![1];
  expect(apply).toEqual([
    "harness",
    "apply",
    expect.any(String),
    "--approve",
    id,
    "--jsonl",
  ]);
  expect(localmodels.mock.calls[0]![1]).toContain(process.execPath);
});
it("does not fall back to an installer when upstream fails", async () => {
  const options = await fixture();
  const run = vi.fn();
  await expect(
    installNativeRuntime("codex", options, {
      run,
      localmodels: vi.fn(async () => ({
        code: 1,
        stdout: "secret",
        stderr: "secret",
      })),
    }),
  ).rejects.toMatchObject({ code: "LOCALMODELS_RUNTIME_UNAVAILABLE" });
  expect(run).not.toHaveBeenCalled();
});
it("honors cancellation before upstream installation", async () => {
  const options = await fixture();
  const localmodels = vi.fn();
  await expect(
    installNativeRuntime(
      "pi",
      { ...options, signal: AbortSignal.abort() },
      { localmodels },
    ),
  ).rejects.toThrow();
  expect(localmodels).not.toHaveBeenCalled();
});

it("keeps runtime plans under private Linger state regardless of the system temp directory", async () => {
  const options = await fixture();
  const parent = await realpath(options.home);
  const target = path.join(parent, "temp-target");
  const alias = path.join(parent, "temp-alias");
  await mkdir(target);
  await symlink(
    target,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, alias);
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan") {
      const file = args[args.indexOf("--out") + 1]!;
      expect(path.dirname(file)).toBe(await realpath(path.dirname(file)));
      expect(path.dirname(path.dirname(file))).toBe(
        path.join(parent, "setup", "harness-plans"),
      );
      await writeFile(
        file,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id: "a".repeat(64),
          runtime: "pi",
        }),
      );
    }
    return {
      code: 0,
      stdout: args[1] === "status" ? JSON.stringify(status("pi", true)) : "",
      stderr: "",
    };
  });
  await expect(
    installNativeRuntime("pi", options, { localmodels }),
  ).resolves.toMatchObject({ state: "ready" });
  expect(await readdir(target)).toEqual([]);
  expect(await readdir(path.join(parent, "setup", "harness-plans"))).toEqual(
    [],
  );
  await expect(
    installNativeRuntime("pi", options, {
      localmodels: async () => ({ code: 1, stdout: "", stderr: "" }),
    }),
  ).rejects.toMatchObject({ code: "LOCALMODELS_RUNTIME_UNAVAILABLE" });
  expect(await readdir(path.join(parent, "setup", "harness-plans"))).toEqual(
    [],
  );
});
it("uses the upstream-selected profile even when the launcher inherited another profile", () => {
  vi.stubEnv("CODEX_HOME", "/external/inherited");
  const descriptor = {
    ...status("codex", true).runtimes[0]!,
    runtime: "codex" as const,
    environment: { CODEX_HOME: "/selected/profile" },
  };
  expect(runtimeEnvironmentFromDescriptors([descriptor]).CODEX_HOME).toBe(
    "/selected/profile",
  );
});

it("preserves the safe timeout category instead of replacing it with runtime unavailable", async () => {
  const options = await fixture();
  const localmodels = vi.fn(async () => {
    throw Object.assign(new Error("Command timed out"), {
      code: "COMMAND_TIMEOUT",
    });
  });
  await expect(
    installNativeRuntime("pi", options, { localmodels }),
  ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  await expect(
    inspectRuntime("pi", options, { localmodels }),
  ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
});

it.each([
  "RUNTIME_VERSION_TIMEOUT",
  "RUNTIME_VERSION_EXECUTION_FAILED",
  "RUNTIME_VERSION_MISMATCH",
])(
  "keeps allowlisted upstream Runtime cause %s without native errors",
  async (code) => {
    const options = await fixture();
    const localmodels = vi.fn(async (_home: string, args: string[]) => {
      if (args[1] === "plan")
        await writeFile(
          args[args.indexOf("--out") + 1]!,
          JSON.stringify({
            schema: "localmodels.harness-plan/v1",
            id: "a".repeat(64),
            runtime: "pi",
          }),
        );
      return {
        code: args[1] === "apply" ? 1 : 0,
        stdout:
          args[1] === "apply"
            ? JSON.stringify({
                schema: "localmodels.harness-error/v1",
                code,
                message: "private-token raw native details",
              })
            : "",
        stderr: "private-token",
      };
    });
    const failure = await installNativeRuntime("pi", options, {
      localmodels,
    }).catch((error: Error & { code: string }) => error);
    expect(failure).toMatchObject({ code });
    expect((failure as Error).message).not.toContain("private-token");
  },
);

it("names the upstream cause of a failed Harness apply and logs its output", async () => {
  const options = await fixture();
  const events: string[] = [];
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan")
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id: "a".repeat(64),
          runtime: "claude",
        }),
      );
    return {
      code: args[1] === "apply" ? 1 : 0,
      stdout:
        args[1] === "apply"
          ? JSON.stringify({
              schema: "localmodels.harness-error/v1",
              code: "HARNESS_DOWNLOAD_FAILED",
              message:
                "Download of claude from downloads.claude.ai failed: timed out.",
            })
          : "",
      stderr: "",
    };
  });
  const failure = await installNativeRuntime(
    "claude",
    { ...options, onEvent: (event) => events.push(event.message) },
    { localmodels },
  ).catch((error: Error & { code: string }) => error);
  expect(failure).toMatchObject({
    code: "LOCALMODELS_RUNTIME_UNAVAILABLE",
    message:
      "The localmodels Runtime operation failed: Download of claude from downloads.claude.ai failed: timed out.",
  });
  expect(events.join("\n")).toContain("HARNESS_DOWNLOAD_FAILED");
});
