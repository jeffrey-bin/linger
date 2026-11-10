import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export async function digestBlobSha256(blob: Blob) {
  const digest = sha256.create();
  if (typeof blob.stream !== "function") {
    // JSDOM and older WebViews lack Blob.stream(); current browsers stay on the
    // incremental path below.
    digest.update(new Uint8Array(await blob.arrayBuffer()));
    return bytesToHex(digest.digest());
  }

  const reader = blob.stream().getReader();

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      digest.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  return bytesToHex(digest.digest());
}
