import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadPublishedSources } from "./main.js";

const distribution = (value: object) => {
  const file = path.join(
    mkdtempSync(path.join(os.tmpdir(), "installer-distribution-")),
    "distribution.json",
  );
  writeFileSync(file, JSON.stringify(value));
  return file;
};

it("leaves the environment alone without a distribution file", async () => {
  const environment = {};
  await loadPublishedSources(
    path.join(os.tmpdir(), "missing", "distribution.json"),
    environment,
  );
  expect(environment).toEqual({});
});

it("exports the published native sources unless already set", async () => {
  const file = distribution({
    platform: process.platform,
    arch: process.arch,
    nativeSources: [],
  });
  const environment: NodeJS.ProcessEnv = {};
  await loadPublishedSources(file, environment);
  expect(environment).toEqual({ LINGER_NATIVE_DEPENDENCIES_JSON: "[]" });

  const preset = { LINGER_NATIVE_DEPENDENCIES_JSON: "preset" };
  await loadPublishedSources(file, preset);
  expect(preset.LINGER_NATIVE_DEPENDENCIES_JSON).toBe("preset");
});

it("exports the published voice tools beside the native sources", async () => {
  const voice = {
    target: "linux-x64",
    file: "native/voice-tools-linux-x64.tar.gz",
    sha256: "b".repeat(64),
    bytes: 100,
    livekitVersion: "1.13.6",
    ffmpegVersion: "8.1.2",
  };
  const file = distribution({
    platform: process.platform,
    arch: process.arch,
    voiceTools: [voice],
  });
  const environment: NodeJS.ProcessEnv = {};
  await loadPublishedSources(file, environment);
  expect(JSON.parse(environment.LINGER_NATIVE_VOICE_TOOLS_JSON!)).toEqual([
    { ...voice, file: path.join(path.dirname(file), voice.file) },
  ]);
});

it("rejects a distribution for another computer", async () => {
  await expect(
    loadPublishedSources(
      distribution({
        platform: "plan9",
        arch: process.arch,
        nativeSources: [],
      }),
      {},
    ),
  ).rejects.toThrow(/does not match/);
});

it("reports the real start failure and points at permissions only for access errors", async () => {
  const { startFailure } = await import("./main.js");
  const busy = Object.assign(
    new Error(
      "An earlier installation is still running. Wait for it to finish or cancel it, then try again.",
    ),
    { code: "INSTALLER_BUSY" },
  );
  expect(startFailure(busy)).toBe(
    "Installer could not start (INSTALLER_BUSY): An earlier installation is still running. Wait for it to finish or cancel it, then try again.",
  );
  expect(startFailure(busy)).not.toContain("permissions");
  const denied = Object.assign(
    new Error("EACCES: permission denied, mkdir '/home/x/installer'"),
    { code: "EACCES" },
  );
  expect(startFailure(denied)).toContain(
    "Check the installation package and home directory permissions.",
  );
});

it("saves keys in the instance's user.env without echoing their values", async () => {
  const { parseInstallerArguments, saveUserKeys } = await import("./main.js");
  expect(() => parseInstallerArguments(["--user-keys"])).toThrow(
    "Keys need an instance.",
  );
  const home = mkdtempSync(path.join(os.tmpdir(), "installer-keys-"));
  const options = parseInstallerArguments([
    "--home",
    home,
    "--instance",
    "desktop",
    "--user-keys",
  ]);
  expect(options.userKeys).toBe(true);
  expect(
    await saveUserKeys(
      options,
      JSON.stringify({
        COMPOSIO_API_KEY: "composio-1",
        SONIOX_API_KEY: "soniox-1",
        XAI_API_KEY: "xai-1",
      }),
    ),
  ).toEqual({ saved: ["COMPOSIO_API_KEY", "SONIOX_API_KEY", "XAI_API_KEY"] });
  expect(
    await saveUserKeys(options, JSON.stringify({ XAI_API_KEY: "" })),
  ).toEqual({ saved: ["COMPOSIO_API_KEY", "SONIOX_API_KEY"] });
  const failed = await saveUserKeys(
    options,
    JSON.stringify({ XAI_API_KEY: "bad value" }),
  );
  expect(failed).toEqual({ error: "XAI_API_KEY is not a valid key" });
  expect(await saveUserKeys(options, "not json")).toEqual({
    error: "Invalid keys",
  });
});
