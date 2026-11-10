import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { JsonLogger } from "@linger/service-kit/node";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HttpHost } from "../src/http-host.js";

// A runtime's package directory, holding the models.json the build writes.
const runtime = vi.hoisted(() => ({ packageRoot: "" }));
vi.mock("../src/paths.js", async (actual) => {
  const paths = await actual<typeof import("../src/paths.js")>();
  return {
    ...paths,
    get packageRoot() {
      return runtime.packageRoot;
    },
  };
});

// An npm tarball of `files` inside its package/ folder.
function tarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.fill(" ", 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const integrity = (body: Buffer) =>
  `sha512-${createHash("sha512").update(body).digest("base64")}`;

const root = mkdtempSync(path.join(os.tmpdir(), "model-packages-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const eng = tarball({
  "package/package.json": '{"name":"@tesseract.js-data/eng"}',
  "package/4.0.0_best_int/eng.traineddata.gz": "eng data",
});
const vad = tarball({ "package/index.node": "binding" });
let home: string;
let environment: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = path.join(root, `home-${Math.random().toString(36).slice(2)}`);
  environment = { AGENT_HOME: home };
  runtime.packageRoot = path.join(home, "runtime");
  await mkdir(runtime.packageRoot, { recursive: true });
  writeFileSync(
    path.join(runtime.packageRoot, "models.json"),
    JSON.stringify({
      packages: {
        "@tesseract.js-data/eng": {
          group: "ocr",
          version: "1.0.0",
          integrity: integrity(eng),
          tarballs: [
            "https://registry.example/eng-1.0.0.tgz",
            "https://mirror.example/eng-1.0.0.tgz",
          ],
        },
        "@livekit/local-inference-linux-x64-gnu": {
          group: "voice",
          version: "0.2.7",
          integrity: integrity(vad),
          tarballs: ["https://registry.example/vad-0.2.7.tgz"],
        },
      },
    }),
  );
  vi.resetModules();
});

// The module reads models.json once, so every test loads it afresh.
const load = () => import("../src/model-packages.js");

describe("model packages", () => {
  it("lists packages by group and resolves them only once installed", async () => {
    const models = await load();
    expect(models.modelPackageNames("ocr")).toEqual(["@tesseract.js-data/eng"]);
    expect(models.modelPackageNames("voice")).toEqual([
      "@livekit/local-inference-linux-x64-gnu",
    ]);
    expect(models.modelPackageDirectory("tesseract.js-core", environment)).toBe(
      undefined,
    );
    expect(() =>
      models.modelPackageDirectory("@tesseract.js-data/eng", environment),
    ).toThrow("Model package @tesseract.js-data/eng is not installed");
  });

  it("downloads from the next registry when one serves another tarball", async () => {
    const models = await load();
    const fetch = vi.fn(async (url: string) =>
      url.startsWith("https://registry.")
        ? new Response(new Uint8Array(vad))
        : new Response(new Uint8Array(eng)),
    );
    await models.installModelPackages(["@tesseract.js-data/eng"], environment, {
      fetch: fetch as typeof globalThis.fetch,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const directory = models.modelPackageDirectory(
      "@tesseract.js-data/eng",
      environment,
    )!;
    expect(directory).toBe(
      path.join(home, "models", "node_modules", "@tesseract.js-data", "eng"),
    );
    expect(
      readFileSync(
        path.join(directory, "4.0.0_best_int/eng.traineddata.gz"),
        "utf8",
      ),
    ).toBe("eng data");
    expect(
      models.modelPackagesInstalled(["@tesseract.js-data/eng"], environment),
    ).toBe(true);
  });

  it("shares one download between callers and waits a minute after a failure", async () => {
    const models = await load();
    let release!: () => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(new Uint8Array(eng)));
        }),
    );
    const options = { fetch: fetch as unknown as typeof globalThis.fetch };
    const first = models.installModelPackages(
      ["@tesseract.js-data/eng"],
      environment,
      options,
    );
    const second = models.installModelPackages(
      ["@tesseract.js-data/eng"],
      environment,
      options,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledOnce();

    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    const voice = ["@livekit/local-inference-linux-x64-gnu"];
    const failing = {
      fetch: offline as unknown as typeof globalThis.fetch,
    };
    await expect(
      models.installModelPackages(voice, environment, failing),
    ).rejects.toThrow(
      "Could not download model package @livekit/local-inference-linux-x64-gnu (registry.example: offline)",
    );
    await expect(
      models.installModelPackages(voice, environment, failing),
    ).rejects.toThrow("Could not download");
    expect(offline).toHaveBeenCalledOnce();
    // Nothing is left behind for the next attempt to trip over.
    expect(existsSync(path.join(home, "models/node_modules/@livekit"))).toBe(
      false,
    );
    expect(models.modelPackagesInstalled(voice, environment)).toBe(false);
  });

  it("keeps a package's files inside its folder", async () => {
    const { unpackTarball } = await load();
    expect(unpackTarball(gunzipSync(eng)).map(([file]) => file)).toEqual([
      "package.json",
      "4.0.0_best_int/eng.traineddata.gz",
    ]);
    expect(() =>
      unpackTarball(gunzipSync(tarball({ "package/../escape": "x" }))),
    ).toThrow("Unsafe path in model package: package/../escape");
  });

  it("installs nothing when the runtime lists no packages", async () => {
    await rm(path.join(runtime.packageRoot, "models.json"));
    const models = await load();
    expect(models.modelPackageNames("ocr")).toEqual([]);
    expect(models.modelPackagesInstalled([], environment)).toBe(true);
    await models.installModelPackages([], environment, {
      fetch: () => {
        throw new Error("no download");
      },
    });
  });
});

describe("features that need model packages", () => {
  it("start the Voice workers once the voice packages install, with them on NODE_PATH", async () => {
    const { startVoiceService } = await import("../src/voice/service.js");
    const models = await load();
    let installed!: () => void;
    const installModels = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          installed = () => {
            const directory = path.join(
              models.modelPackagesRoot(environment),
              "@livekit/local-inference-linux-x64-gnu",
            );
            void mkdir(directory, { recursive: true }).then(() => {
              writeFileSync(
                path.join(directory, ".simplex-model-package.json"),
                JSON.stringify({ integrity: integrity(vad) }),
              );
              resolve();
            });
          };
        }),
    );
    const spawnWorker = vi.fn(
      () =>
        Object.assign(new EventEmitter(), {
          kill: vi.fn(() => true),
        }) as unknown as ChildProcess,
    );
    const service = await startVoiceService({
      logger: { log: vi.fn() } as unknown as JsonLogger,
      http: { mount: () => () => {} } as unknown as HttpHost,
      environment: { ...environment, XAI_API_KEY: "test" },
      spawnWorker,
      installModels,
    });
    expect(installModels).toHaveBeenCalledOnce();
    expect(spawnWorker).not.toHaveBeenCalled();
    installed();
    await vi.waitFor(() => expect(spawnWorker).toHaveBeenCalledWith("live"));
    const stopping = service.stop();
    (spawnWorker.mock.results[0]!.value as EventEmitter).emit("exit", 0, null);
    await stopping;
  });

  it("convert documents when the OCR packages cannot install", async () => {
    const { WorkerDocumentNormalizer } =
      await import("../src/document-normalizer/document-normalizer.js");
    const failure = new Error("offline");
    const onModelsUnavailable = vi.fn();
    const normalizer = new WorkerDocumentNormalizer({
      execute: async () => new TextEncoder().encode("text\n"),
      installModels: async () => {
        throw failure;
      },
      onModelsUnavailable,
    });
    const markdown = await normalizer.normalizeDocument({
      filename: "scan.pdf",
      mediaType: "application/pdf",
      source: new TextEncoder().encode("%PDF-1.4"),
    });
    expect(new TextDecoder().decode(markdown)).toBe("text\n");
    expect(onModelsUnavailable).toHaveBeenCalledWith(failure);
  });
});
