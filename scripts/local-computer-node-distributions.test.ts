import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureNodeRuntimeArchive,
  ensureNodeRuntimeArchives,
  NODE_RUNTIME_RELEASES,
  NODE_RUNTIME_VERSION,
  nodeRuntimeDownloadUrls,
  parseNodeDistributionArguments,
  RELEASE_TARGETS,
} from "./local-computer-node-distributions.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

function checksum(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "node-distributions-"));
  temporaryRoots.push(root);
  return root;
}

describe("Local Computer Node distributions", () => {
  it("pins all six platform archives and checksums", () => {
    expect(NODE_RUNTIME_VERSION).toBe("26.5.0");
    expect(RELEASE_TARGETS).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    for (const target of RELEASE_TARGETS) {
      expect(NODE_RUNTIME_RELEASES[target].archive).toBe(
        target.startsWith("win32-")
          ? `node-v26.5.0-${target.replace("win32", "win")}.zip`
          : `node-v26.5.0-${target}.tar.gz`,
      );
      expect(NODE_RUNTIME_RELEASES[target].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("requires an output and accepts an overridable download base", () => {
    expect(
      parseNodeDistributionArguments([
        "--download-base-url",
        "https://mirror.example.test/node",
        "--output",
        "/tmp/node",
      ]),
    ).toEqual({
      downloadBaseUrl: "https://mirror.example.test/node",
      output: "/tmp/node",
    });
    expect(() => parseNodeDistributionArguments([])).toThrow(
      "--output is required",
    );
  });

  it("downloads every missing platform and verifies fixed checksums", async () => {
    const root = await temporaryRoot();
    const releases = Object.fromEntries(
      RELEASE_TARGETS.map((target) => {
        const content = `fixture-${target}`;
        return [
          target,
          { archive: `${target}.tar.gz`, content, sha256: checksum(content) },
        ];
      }),
    );
    const fetchImplementation = vi.fn(async (url: string) => {
      const release = Object.values(releases).find((entry) =>
        url.endsWith(entry.archive),
      );
      return new Response(release?.content ?? "missing", {
        status: release ? 200 : 404,
      });
    });

    await ensureNodeRuntimeArchives(root, {
      downloadBaseUrl: "https://mirror.example.test/node",
      fetchImplementation,
      releases,
      version: "99.1.0",
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(6);
    for (const release of Object.values(releases)) {
      await expect(
        readFile(path.join(root, release.archive), "utf8"),
      ).resolves.toBe(release.content);
    }
    expect(fetchImplementation.mock.calls[0][0]).toContain("/v99.1.0/");
  });

  it("reuses an existing verified archive without network access", async () => {
    const root = await temporaryRoot();
    const content = "already-valid";
    const releases = {
      "linux-x64": {
        archive: "node-linux-x64.tar.gz",
        sha256: checksum(content),
      },
    };
    await writeFile(path.join(root, releases["linux-x64"].archive), content);
    const fetchImplementation = vi.fn();

    await ensureNodeRuntimeArchive("linux-x64", root, {
      fetchImplementation,
      releases,
    });

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("atomically replaces a damaged archive after a verified download", async () => {
    const root = await temporaryRoot();
    const content = "replacement";
    const releases = {
      "linux-x64": {
        archive: "node-linux-x64.tar.gz",
        sha256: checksum(content),
      },
    };
    const destination = path.join(root, releases["linux-x64"].archive);
    await writeFile(destination, "damaged");

    await ensureNodeRuntimeArchive("linux-x64", root, {
      fetchImplementation: async () => new Response(content),
      releases,
    });

    await expect(readFile(destination, "utf8")).resolves.toBe(content);
    expect(
      (await readdir(root)).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("rejects a checksum mismatch without publishing a partial file", async () => {
    const root = await temporaryRoot();
    const releases = {
      "linux-x64": {
        archive: "node-linux-x64.tar.gz",
        sha256: checksum("expected"),
      },
    };
    const destination = path.join(root, releases["linux-x64"].archive);
    await writeFile(destination, "damaged");

    await expect(
      ensureNodeRuntimeArchive("linux-x64", root, {
        fetchImplementation: async () => new Response("wrong"),
        releases,
      }),
    ).rejects.toThrow("checksum mismatch");
    await expect(readFile(destination, "utf8")).resolves.toBe("damaged");
    expect(
      (await readdir(root)).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("falls back to the mirror when nodejs.org fails, stalls or alters the archive", async () => {
    const content = "pinned";
    const releases = {
      "linux-x64": {
        archive: "node-linux-x64.tar.gz",
        sha256: checksum(content),
      },
    };
    expect(nodeRuntimeDownloadUrls("node-linux-x64.tar.gz", "99.1.0")).toEqual([
      "https://nodejs.org/dist/v99.1.0/node-linux-x64.tar.gz",
      "https://cdn.npmmirror.com/binaries/node/v99.1.0/node-linux-x64.tar.gz",
    ]);
    const official = [
      () => new Response("missing", { status: 404 }),
      () => new Response("altered"),
      // Sends nothing and never ends.
      () => new Response(new ReadableStream()),
    ];
    for (const primary of official) {
      const root = await temporaryRoot();
      const hosts: string[] = [];
      const destination = await ensureNodeRuntimeArchive("linux-x64", root, {
        fetchImplementation: async (url: string) => {
          hosts.push(new URL(url).host);
          return new URL(url).host === "nodejs.org"
            ? primary()
            : new Response(content);
        },
        idleTimeoutMs: 20,
        releases,
        version: "99.1.0",
      });
      expect(hosts).toEqual(["nodejs.org", "cdn.npmmirror.com"]);
      await expect(readFile(destination, "utf8")).resolves.toBe(content);
    }
  });

  it("names the archive and every host when all of them fail", async () => {
    const root = await temporaryRoot();
    await expect(
      ensureNodeRuntimeArchive("linux-x64", root, {
        fetchImplementation: async () => new Response("gone", { status: 503 }),
        releases: {
          "linux-x64": {
            archive: "node-linux-x64.tar.gz",
            sha256: checksum("x"),
          },
        },
      }),
    ).rejects.toThrow(
      "Node runtime download of node-linux-x64.tar.gz failed (nodejs.org: HTTP 503; cdn.npmmirror.com: HTTP 503).",
    );
    expect(await readdir(root)).toEqual([]);
  });
});
