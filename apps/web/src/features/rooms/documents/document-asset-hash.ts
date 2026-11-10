import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { documentAssetHashChunkBytes } from "./document-asset-hash-protocol";

export async function hashBlobIncrementally(blob: Blob) {
  const digest = sha256.create();
  let bytesRead = 0;
  for (
    let offset = 0;
    offset < blob.size;
    offset += documentAssetHashChunkBytes
  ) {
    const expectedBytes = Math.min(
      documentAssetHashChunkBytes,
      blob.size - offset,
    );
    // Sequential reads keep resident memory bounded to one chunk.
    // oxlint-disable-next-line react-doctor/async-await-in-loop
    const buffer = await blob
      .slice(offset, offset + expectedBytes)
      .arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== expectedBytes) {
      throw new DocumentAssetChangedError();
    }
    digest.update(bytes);
    bytesRead += bytes.byteLength;
  }
  return { bytesRead, sha256: bytesToHex(digest.digest()) };
}

export class DocumentAssetChangedError extends Error {
  constructor() {
    super("Document Asset changed while it was being read.");
    this.name = "DocumentAssetChangedError";
  }
}
