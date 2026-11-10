import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readPublishedSource } from "./published-source.js";
it("preserves the image layer budget separately from a small GHCR startup resource pack", async () => {
  const source = {
    url: "https://downloads.example/startup.tgz",
    sha256: "a".repeat(64),
    bytes: 40000000,
    delivery: "ghcr",
    imageDownloadBytes: 565001761,
  };
  expect(await readPublishedSource(await metadata(source))).toEqual(source);
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function metadata(serviceRelease: unknown, target = process.platform) {
  const root = await mkdtemp(path.join(os.tmpdir(), "linger-channel-"));
  roots.push(root);
  const file = path.join(root, "distribution.json");
  await writeFile(
    file,
    JSON.stringify({ platform: target, arch: process.arch, serviceRelease }),
  );
  return file;
}
it("loads the publisher's pinned service source without user environment setup", async () => {
  const source = {
    url: "https://downloads.example/install/1.0.0/release.tgz",
    sha256: "a".repeat(64),
    bytes: 1_419_822_394,
  };
  expect(await readPublishedSource(await metadata(source))).toEqual(source);
});
it("rejects unsafe or incomplete publisher metadata before any download", async () => {
  for (const source of [
    { url: "https://downloads.example/release.tgz" },
    { url: "https://downloads.example/release.tgz", sha256: "a".repeat(64) },
    { url: "http://downloads.example/release.tgz", sha256: "a".repeat(64) },
    {
      url: "https://secret@downloads.example/release.tgz",
      sha256: "a".repeat(64),
      bytes: 1_419_822_394,
    },
    {
      url: "https://downloads.example/release.tgz?token=x",
      sha256: "a".repeat(64),
      bytes: 1_419_822_394,
    },
  ])
    await expect(readPublishedSource(await metadata(source))).rejects.toThrow();
});
it("rejects metadata for another operating system", async () => {
  await expect(
    readPublishedSource(
      await metadata(
        {
          url: "https://downloads.example/release.tgz",
          sha256: "a".repeat(64),
          bytes: 1_419_822_394,
        },
        process.platform === "linux" ? "darwin" : "linux",
      ),
    ),
  ).rejects.toThrow(/target/i);
});
it("keeps the explicit developer/local release path usable without bundled online metadata", async () => {
  expect(
    await readPublishedSource("/no-such-linger-distribution/distribution.json"),
  ).toBeUndefined();
});
it("keeps the publisher's mirrors and checks them like the primary URL", async () => {
  const source = {
    url: "https://downloads.example/release.tgz",
    mirrors: ["https://mirror.example/release.tgz"],
    sha256: "a".repeat(64),
    bytes: 1_419_822_394,
  };
  expect(await readPublishedSource(await metadata(source))).toEqual(source);
  for (const mirrors of [
    "https://mirror.example/release.tgz",
    ["http://mirror.example/release.tgz"],
    ["https://mirror.example/release.tgz?token=x"],
    [1],
  ])
    await expect(
      readPublishedSource(await metadata({ ...source, mirrors })),
    ).rejects.toThrow();
});
