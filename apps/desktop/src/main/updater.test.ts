import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ComputerDaemonModule } from "./computer-daemon.js";
import { stubModule, tempDirectory, testHost } from "./test-support.js";
import { type UpdaterOptions, UpdaterModule, appBundleOf } from "./updater.js";

const SERVER = "https://linger.example.com";
const PACKAGE = Buffer.from("new app archive");

const release = (version: string, body = PACKAGE) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      version,
      packages: {
        "darwin-arm64": {
          file: `Linger-${version}-arm64.tar.gz`,
          sha256: createHash("sha256").update(PACKAGE).digest("hex"),
          size: PACKAGE.length,
        },
      },
    }),
  );
  const files: Record<string, Buffer> = {
    "manifest.json": manifest,
    "manifest.json.sig": Buffer.from(
      sign(null, manifest, privateKey).toString("base64"),
    ),
    [`Linger-${version}-arm64.tar.gz`]: body,
  };
  const requested: string[] = [];
  const fetch = (async (url: URL) => {
    requested.push(url.pathname);
    const name = url.pathname.replace("/install/desktop/stable/", "");
    const file = files[name];
    return file
      ? new Response(new Uint8Array(file))
      : new Response("missing", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    requested,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

const setup = async (
  feed: ReturnType<typeof release>,
  options: Partial<UpdaterOptions> = {},
) => {
  const root = tempDirectory();
  const applications = path.join(root, "Applications");
  const bundle = path.join(applications, "Linger.app");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, "version"), "0.16.7");
  const downloads = path.join(root, "updates");
  let running = 0;
  let restarts = 0;
  const runtime = {
    ...stubModule("ComputerDaemon"),
    running: () => running,
  } as unknown as ComputerDaemonModule;
  const updater = new UpdaterModule({
    version: "0.16.7",
    platform: "darwin",
    arch: "arm64",
    appBundle: bundle,
    downloadDirectory: downloads,
    restart: async () => {
      restarts += 1;
    },
    fetch: feed.fetch,
    publicKey: feed.publicKey,
    checkDelayMs: 60 * 60_000,
    // The test archive holds the new version marker, not a real tarball.
    extract: async (archive, directory) => {
      const app = path.join(directory, "Linger.app");
      mkdirSync(app);
      writeFileSync(path.join(app, "version"), readFileSync(archive));
    },
    ...options,
  });
  const host = testHost([stubModule("Config"), runtime, updater], {
    serverUrl: SERVER,
  });
  await host.start();
  const setRunning = (n: number) => {
    running = n;
    host.ctx.bus.emit("runtime.activity", n);
  };
  return {
    host,
    updater,
    bundle,
    applications,
    downloads,
    setRunning,
    restarts: () => restarts,
  };
};

describe("UpdaterModule", () => {
  it("installs a verified update once running tasks finish", async () => {
    const feed = release("0.17.0");
    const { updater, bundle, applications, setRunning, restarts, host } =
      await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(readFileSync(path.join(bundle, "version"), "utf8")).toBe("0.16.7");

    setRunning(1);
    await updater.install();
    expect(updater.state()).toEqual({ kind: "waiting", version: "0.17.0" });
    expect(restarts()).toBe(0);

    setRunning(0);
    await waitFor(() => restarts() === 1);
    expect(readFileSync(path.join(bundle, "version"), "utf8")).toBe(
      PACKAGE.toString(),
    );
    // The replaced bundle stays until the next launch cleans it up.
    expect(readdirSync(applications).sort()).toEqual([
      expect.stringMatching(/^\.Linger-old-/),
      "Linger.app",
    ]);
    await host.stop("update");
    const next = new UpdaterModule({
      version: "0.17.0",
      platform: "darwin",
      arch: "arm64",
      appBundle: bundle,
      downloadDirectory: tempDirectory(),
      restart: async () => {},
      checkDelayMs: 60 * 60_000,
    });
    await testHost([stubModule("Config"), stubModule("ComputerDaemon"), next])
      .start()
      .then(() => waitFor(() => readdirSync(applications).length === 1));
    expect(readdirSync(applications)).toEqual(["Linger.app"]);
  });

  it("refuses a manifest signed by another key", async () => {
    const feed = {
      ...release("0.17.0"),
      publicKey: release("0.17.0").publicKey,
    };
    const { updater } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update signature does not match",
    });
    expect(feed.requested).not.toContain(
      "/install/desktop/stable/Linger-0.17.0-arm64.tar.gz",
    );
  });

  it("refuses a package that does not match its checksum", async () => {
    const feed = release("0.17.0", Buffer.from("new app archivX"));
    const { updater, downloads, applications } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update package does not match its checksum",
    });
    expect(readdirSync(downloads)).toEqual([]);
    expect(readdirSync(applications)).toEqual(["Linger.app"]);
    await updater.install();
    expect(updater.state().kind).toBe("failed");
  });

  it("retries a dropped download soon instead of waiting a full interval", async () => {
    const feed = release("0.17.0");
    let drops = 1;
    const flaky = (async (url: URL) => {
      if (url.pathname.endsWith(".tar.gz") && drops-- > 0)
        throw new TypeError("terminated");
      return feed.fetch(url);
    }) as unknown as typeof globalThis.fetch;
    const { updater, host } = await setup(feed, {
      fetch: flaky,
      checkDelayMs: 1,
      retryDelayMs: 1,
      checkIntervalMs: 60 * 60_000,
    });
    await waitFor(() => updater.state().kind === "ready");
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    await host.stop("quit");
  });

  it("stays idle when the server has nothing newer", async () => {
    const feed = release("0.16.7");
    const { updater } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
    expect(feed.requested).toHaveLength(2);
  });
});

describe("UpdaterModule with services on this computer", () => {
  it("updates them from the app on request instead of asking the server", async () => {
    const feed = release("0.17.0");
    let available = false;
    let updates = 0;
    let announced = 0;
    const { updater, host } = await setup(feed, {
      services: {
        serving: (serverUrl) => serverUrl === SERVER,
        sourceUpdateAvailable: () => available,
        updateSource: async () => {
          updates += 1;
          available = false;
        },
      },
      announceServices: () => {
        announced += 1;
      },
    });
    await updater.check();
    expect(feed.requested).toEqual([]);
    expect(updater.state()).toEqual({ kind: "idle" });

    available = true;
    host.ctx.bus.emit("local-server.changed");
    expect(updater.state()).toEqual({
      kind: "ready",
      version: "0.16.7",
      services: true,
    });
    expect(announced).toBe(1);
    expect(updates).toBe(0);

    await updater.install();
    expect(updates).toBe(1);
    expect(updater.state()).toEqual({ kind: "idle" });
    await host.stop("quit");
  });
});

describe("appBundleOf", () => {
  it("finds the app bundle around the executable", () => {
    expect(appBundleOf("/Applications/Linger.app/Contents/MacOS/Linger")).toBe(
      "/Applications/Linger.app",
    );
    expect(appBundleOf("/usr/lib/electron/electron")).toBeUndefined();
  });
});

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
};
