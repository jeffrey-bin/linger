import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareWebDevelopment } from "./prepare-web-dev.mjs";

describe("Web development preparation", () => {
  it("fails when the Vite port is occupied", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test address.");
    }

    await expect(
      prepareWebDevelopment({
        environment: { PORT: String(address.port) },
        loadDevelopmentEnvironment: () => ({}),
      }),
    ).rejects.toThrow(/already in use/);
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  });

  it("uses the Vite development environment port fallback", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test address.");
    }

    await expect(
      prepareWebDevelopment({
        environment: {},
        loadDevelopmentEnvironment: () => ({ PORT: String(address.port) }),
      }),
    ).rejects.toThrow(/already in use/);
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  });

  it("checks the port without preparing local CLI assets", async () => {
    await expect(
      prepareWebDevelopment({
        environment: { PORT: "0" },
        loadDevelopmentEnvironment: () => ({}),
      }),
    ).resolves.toBeUndefined();
    expect(
      await readFile(resolve("scripts/prepare-web-dev.mjs"), "utf8"),
    ).not.toContain("prepare-local-computer-release");
    const webPackage = JSON.parse(
      await readFile(resolve("apps/web/package.json"), "utf8"),
    );
    expect(webPackage.scripts.predev).toBe(
      "node ../../scripts/prepare-web-dev.mjs",
    );
  });
});
