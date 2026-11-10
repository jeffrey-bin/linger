import { afterEach, expect, it, vi } from "vitest";
import { parseInstallerArguments } from "../main.js";
import { coreAdapter } from "./core.js";
import {
  installNativeSource,
  checkNativeSourceEnvironment,
} from "@linger/local-installation/native-source";
import { validateInput } from "./validation.js";
vi.mock("@linger/local-installation/native-source", () => ({
  installNativeSource: vi.fn(async () => ({
    code: 0,
    state: "ready",
    message: "native ready",
  })),
  checkNativeSourceEnvironment: vi.fn(async () => ({
    releaseAvailable: true,
    platform: "linux",
    arch: "x64",
    checks: [
      {
        id: "source-native",
        title: "Native source",
        state: "ready",
        detail: "Ready",
      },
    ],
  })),
  probeNativeSourceServices: vi.fn(),
  stopNativeSource: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
it("selects source only from trusted process options and rejects browser path injection", () => {
  expect(
    parseInstallerArguments(["--source-repo", "/checkout"]).sourceRepo,
  ).toBe("/checkout");
  expect(
    parseInstallerArguments([
      "--source-repo",
      "/checkout",
      "--instance",
      "source-dev",
    ]).instanceName,
  ).toBe("source-dev");
  expect(() =>
    parseInstallerArguments([
      "--source-repo",
      "/checkout",
      "--instance",
      "../escape",
    ]),
  ).toThrow();
  expect(() => parseInstallerArguments(["--source-repo"])).toThrow();
  expect(() => parseInstallerArguments([])).toThrow(/source checkout/);
  expect(() =>
    validateInput({ instance: "default", sourceRepo: "/other" }),
  ).toThrow();
});
it("routes browser installs and environment checks to the native source core", async () => {
  const adapter = coreAdapter("/private-home", "/checkout");
  const signal = new AbortController().signal;
  const emit = vi.fn();
  await adapter.run({ instance: "source", setupChoice: "pi" }, signal, emit);
  expect(installNativeSource).toHaveBeenCalledWith(
    expect.objectContaining({
      repo: "/checkout",
      name: "source",
      home: "/private-home",
      setupChoice: "pi",
      signal,
      onEvent: emit,
    }),
  );
  expect((await adapter.environment()).checks[0]?.id).toBe("source-native");
  expect(checkNativeSourceEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({ repo: "/checkout" }),
  );
  expect((await adapter.config("source")).releaseAvailable).toBe(true);
});
it("rejects the retired Docker and release preparations", () => {
  for (const preparation of ["docker", "release"])
    expect(() => validateInput({ instance: "default", preparation })).toThrow(
      "Invalid dependency",
    );
  expect(() =>
    parseInstallerArguments([
      "--source-repo",
      "/checkout",
      "--source-engine",
      "native",
    ]),
  ).toThrow();
});
it("resumes only a named source instance", () => {
  const source = ["--source-repo", "/checkout"];
  expect(
    parseInstallerArguments([...source, "--instance", "desktop", "--resume"]),
  ).toMatchObject({ resume: true, instanceName: "desktop" });
  expect(() => parseInstallerArguments([...source, "--resume"])).toThrow();
});
it("hands the Computer to the desktop client on request", () => {
  expect(
    parseInstallerArguments([
      "--source-repo",
      "/checkout",
      "--external-computer",
    ]),
  ).toMatchObject({ externalComputer: true });
});
