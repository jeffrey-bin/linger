import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ManifestError,
  compareVersions,
  packageFor,
  verifyManifest,
} from "./update-manifest.js";

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

const manifest = {
  schema: 1,
  version: "0.16.1",
  packages: {
    "darwin-arm64": {
      file: "Linger-0.16.1-arm64.tar.gz",
      sha256: "a".repeat(64),
      size: 10,
    },
  },
};

const signed = (value: unknown, privateKey = keys().privateKey) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, signature: sign(null, bytes, privateKey).toString("base64") };
};

describe("update manifest", () => {
  it("accepts a manifest signed by the release key", () => {
    const { privateKey, publicPem } = keys();
    const { bytes, signature } = signed(manifest, privateKey);
    const parsed = verifyManifest(bytes, signature, publicPem);
    expect(packageFor(parsed, "darwin", "arm64")?.file).toBe(
      "Linger-0.16.1-arm64.tar.gz",
    );
    expect(packageFor(parsed, "darwin", "x64")).toBeUndefined();
  });

  it("rejects tampered bytes and other keys", () => {
    const { privateKey, publicPem } = keys();
    const { bytes, signature } = signed(manifest, privateKey);
    const tampered = Buffer.from(bytes.toString().replace("0.16.1", "9.9.9"));
    expect(() => verifyManifest(tampered, signature, publicPem)).toThrow(
      ManifestError,
    );
    const other = signed(manifest);
    expect(() =>
      verifyManifest(other.bytes, other.signature, publicPem),
    ).toThrow(ManifestError);
  });

  it("rejects package paths outside the feed", () => {
    const { privateKey, publicPem } = keys();
    const bad = structuredClone(manifest);
    bad.packages["darwin-arm64"].file = "../Linger.tar.gz";
    const { bytes, signature } = signed(bad, privateKey);
    expect(() => verifyManifest(bytes, signature, publicPem)).toThrow(
      "Update manifest is invalid",
    );
  });

  it("compares versions numerically", () => {
    expect(compareVersions("0.16.10", "0.16.9")).toBeGreaterThan(0);
    expect(compareVersions("0.16.0", "0.16.0")).toBe(0);
    expect(compareVersions("0.15.9", "0.16.0")).toBeLessThan(0);
  });
});
