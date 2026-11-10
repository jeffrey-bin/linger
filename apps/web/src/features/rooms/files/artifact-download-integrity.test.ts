import { describe, expect, it } from "vitest";

import { verifyArtifactDownloadIntegrity } from "./artifact-download-integrity";

const helloSha256 =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("Artifact download integrity", () => {
  it("verifies immutable size, media type, and SHA-256 before rendering", async () => {
    const verified = await verifyArtifactDownloadIntegrity(
      {
        media_type: "text/plain",
        sha256: helloSha256,
        size_bytes: 5,
      },
      {
        blob: new Blob(["hello"], { type: "application/octet-stream" }),
        mediaType: "application/octet-stream",
      },
    );

    expect(verified.blob.type).toBe("text/plain");
    expect(verified.mediaType).toBe("text/plain");
  });

  it("rejects same-sized bytes whose SHA-256 differs", async () => {
    await expect(
      verifyArtifactDownloadIntegrity(
        {
          media_type: "text/plain",
          sha256: helloSha256,
          size_bytes: 5,
        },
        {
          blob: new Blob(["HELLO"], { type: "text/plain" }),
          mediaType: "text/plain",
        },
      ),
    ).rejects.toThrow(/SHA-256 does not match/);
  });

  it("rejects size and media-type disagreement before hashing", async () => {
    await expect(
      verifyArtifactDownloadIntegrity(
        {
          media_type: "text/plain",
          sha256: helloSha256,
          size_bytes: 6,
        },
        {
          blob: new Blob(["hello"], { type: "image/png" }),
          mediaType: "image/png",
        },
      ),
    ).rejects.toThrow(/bytes do not match/);
  });
});
