import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";

import {
  DocumentAssetChangedError,
  hashBlobIncrementally,
} from "./document-asset-hash";
import { documentAssetHashChunkBytes } from "./document-asset-hash-protocol";

describe("Document Asset incremental hashing", () => {
  it("reads large files as bounded chunks and returns complete evidence", async () => {
    const bytes = new Uint8Array(documentAssetHashChunkBytes * 2 + 17);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }
    const file = new File([bytes], "large.bin");
    const slice = vi.spyOn(file, "slice");

    await expect(hashBlobIncrementally(file)).resolves.toEqual({
      bytesRead: bytes.byteLength,
      sha256: bytesToHex(sha256(bytes)),
    });
    expect(slice).toHaveBeenCalledTimes(3);
    expect(
      slice.mock.calls.every(
        ([start, end]) =>
          typeof start === "number" &&
          typeof end === "number" &&
          end - start <= documentAssetHashChunkBytes,
      ),
    ).toBe(true);
  });

  it("reports a short chunk read as a typed changed-asset error", async () => {
    const blob = {
      size: 4,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(2) }),
    } as unknown as Blob;

    await expect(hashBlobIncrementally(blob)).rejects.toBeInstanceOf(
      DocumentAssetChangedError,
    );
  });
});
