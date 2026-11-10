import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import type { Instance } from "./instance.js";
import {
  adoptUserEnvironment,
  readUserEnvironment,
  userEnvironmentFile,
  updateUserKeys,
  userEnvironmentPending,
  voiceEnabled,
} from "./user-environment.js";

const root = () => mkdtemp(path.join(tmpdir(), "linger-user-env-"));

describe("readUserEnvironment", () => {
  it("creates a private commented template once and never rewrites it", async () => {
    const directory = await root();
    expect(await readUserEnvironment(directory)).toEqual({});
    const file = userEnvironmentFile(directory);
    const template = await readFile(file, "utf8");
    expect(parseEnv(template)).toEqual({
      COMPOSIO_API_KEY: "",
      SONIOX_API_KEY: "",
      XAI_API_KEY: "",
      TZ: "",
    });
    if (process.platform !== "win32")
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, "SONIOX_API_KEY=' soniox '\n");
    expect(await readUserEnvironment(directory)).toEqual({
      SONIOX_API_KEY: "soniox",
    });
    expect(await readFile(file, "utf8")).toBe("SONIOX_API_KEY=' soniox '\n");
  });

  it("ignores installer-managed and unknown names with a warning naming only the variable", async () => {
    const directory = await root();
    await writeFile(
      userEnvironmentFile(directory),
      "LINGER_SECRET_SEED=override\nSIMPLEX_HTTP_PORT=1\nXAI_API_KEY=xai\n",
      { mode: 0o600 },
    );
    const warnings: string[] = [];
    expect(
      await readUserEnvironment(directory, (message) => warnings.push(message)),
    ).toEqual({ XAI_API_KEY: "xai" });
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("LINGER_SECRET_SEED");
    expect(warnings.join("\n")).not.toContain("override");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a file others can read and says how to fix it",
    async () => {
      const directory = await root();
      const file = userEnvironmentFile(directory);
      await writeFile(file, "XAI_API_KEY=xai\n");
      await chmod(file, 0o644);
      await expect(readUserEnvironment(directory)).rejects.toThrow(/chmod 600/);
    },
  );

  it("turns voice on for either voice key", () => {
    expect(voiceEnabled({})).toBe(false);
    expect(voiceEnabled({ COMPOSIO_API_KEY: "c", TZ: "UTC" })).toBe(false);
    expect(voiceEnabled({ SONIOX_API_KEY: "s" })).toBe(true);
    expect(voiceEnabled({ XAI_API_KEY: "x" })).toBe(true);
  });
});

describe("userEnvironmentPending", () => {
  it("compares user.env with the configuration the services started with", async () => {
    const directory = await root();
    const instance = { root: directory, mode: "source-native" } as Instance;
    expect(await userEnvironmentPending(instance)).toBe(true);
    await writeFile(
      path.join(directory, "native.env"),
      "LOCAL_ENV_FILE='x'\nXAI_API_KEY='xai'\n",
      { mode: 0o600 },
    );
    await writeFile(userEnvironmentFile(directory), "XAI_API_KEY=xai\n", {
      mode: 0o600,
    });
    expect(await userEnvironmentPending(instance)).toBe(false);
    await writeFile(userEnvironmentFile(directory), "XAI_API_KEY=\n");
    expect(await userEnvironmentPending(instance)).toBe(true);
    await writeFile(
      userEnvironmentFile(directory),
      "XAI_API_KEY=xai\nSONIOX_API_KEY=new\n",
    );
    expect(await userEnvironmentPending(instance)).toBe(true);
  });

  it("reads native.env for a native instance", async () => {
    const directory = await root();
    const instance = { root: directory, mode: "source-native" } as Instance;
    await writeFile(path.join(directory, "native.env"), "TZ='UTC'\n", {
      mode: 0o600,
    });
    await writeFile(userEnvironmentFile(directory), "TZ=UTC\n", {
      mode: 0o600,
    });
    expect(await userEnvironmentPending(instance)).toBe(false);
  });
});

describe("adoptUserEnvironment", () => {
  it("moves allowed keys into user.env, keeps keys it already sets and deletes the old file", async () => {
    const home = await root();
    const instanceRoot = path.join(home, "instances", "desktop");
    const legacy = path.join(home, "source.env");
    await writeFile(
      legacy,
      "COMPOSIO_API_KEY=composio\nSONIOX_API_KEY=old-soniox\nTEAMHUB_SECRET_ENCRYPTION_KEY=other\nXAI_API_KEY=\n",
    );
    const ignored: string[][] = [];
    expect(
      await adoptUserEnvironment(instanceRoot, legacy, (names) =>
        ignored.push(names),
      ),
    ).toEqual(["COMPOSIO_API_KEY", "SONIOX_API_KEY"]);
    // Only the names of what it leaves behind, never the values.
    expect(ignored).toEqual([["TEAMHUB_SECRET_ENCRYPTION_KEY"]]);
    await expect(stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readUserEnvironment(instanceRoot)).toEqual({
      COMPOSIO_API_KEY: "composio",
      SONIOX_API_KEY: "old-soniox",
    });
    const contents = await readFile(userEnvironmentFile(instanceRoot), "utf8");
    expect(contents).not.toContain("TEAMHUB_SECRET_ENCRYPTION_KEY");
    expect(contents).toContain("# Your own keys");

    await writeFile(legacy, "SONIOX_API_KEY=older\nXAI_API_KEY=xai\n");
    expect(await adoptUserEnvironment(instanceRoot, legacy)).toEqual([
      "XAI_API_KEY",
    ]);
    expect(await readUserEnvironment(instanceRoot)).toMatchObject({
      SONIOX_API_KEY: "old-soniox",
      XAI_API_KEY: "xai",
    });
  });

  it("does nothing without the old file", async () => {
    const home = await root();
    const instanceRoot = path.join(home, "instances", "desktop");
    expect(
      await adoptUserEnvironment(instanceRoot, path.join(home, "missing.env")),
    ).toEqual([]);
    await expect(stat(instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("updateUserKeys", () => {
  it("saves keys owner-only before the instance exists and keeps the rest of the file", async () => {
    const directory = path.join(await root(), "instances", "desktop");
    expect(
      await updateUserKeys(directory, { COMPOSIO_API_KEY: "composio-1" }),
    ).toEqual(["COMPOSIO_API_KEY"]);
    const file = userEnvironmentFile(directory);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    // The template's comments and other names stay.
    expect(await readFile(file, "utf8")).toContain("# Recording, dictation");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("TZ=", "TZ=Asia/Shanghai"),
    );
    await updateUserKeys(directory, {
      SONIOX_API_KEY: "soniox-1",
      XAI_API_KEY: "xai-1",
    });
    expect(
      await updateUserKeys(directory, {
        COMPOSIO_API_KEY: "",
        XAI_API_KEY: "xai-2",
      }),
    ).toEqual(["SONIOX_API_KEY", "XAI_API_KEY"]);
    expect(await readUserEnvironment(directory)).toEqual({
      SONIOX_API_KEY: "soniox-1",
      XAI_API_KEY: "xai-2",
      TZ: "Asia/Shanghai",
    });
  });

  it("rejects unknown names and values that would break env files, never echoing them", async () => {
    const directory = await root();
    for (const changes of [
      { LINGER_SECRET_SEED: "x" },
      { TZ: "UTC" },
      { SONIOX_API_KEY: "two words" },
      { SONIOX_API_KEY: "a\nXAI_API_KEY=b" },
      { XAI_API_KEY: "x".repeat(513) },
      { XAI_API_KEY: 1 },
    ])
      await expect(
        updateUserKeys(directory, changes as never),
      ).rejects.toThrow();
    await expect(
      updateUserKeys(directory, { SONIOX_API_KEY: "secret value" }),
    ).rejects.toThrow(/^SONIOX_API_KEY is not a valid key$/);
  });
});
