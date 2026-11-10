import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { type TeamHubAuthenticationReason } from "./teamhub-authentication";
import { readTeamHubError } from "./teamhub-error";
import type {
  TeamHubArtifactContent,
  TeamHubArtifactDownloadOptions,
  TeamHubArtifactRangeContent,
  TeamHubArtifactRangeOptions,
} from "./teamhub-types";

export const MAXIMUM_ARTIFACT_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const defaultDownloadTimeoutMs = 2 * 60 * 1_000;

export function downloadTeamHubArtifactContent({
  fetchRequest,
  onAuthenticationRequired,
  options,
  retryAccepted = false,
  url,
  verifyResponseSha256 = false,
}: {
  fetchRequest: typeof fetch;
  onAuthenticationRequired: (reason: TeamHubAuthenticationReason) => void;
  options?: TeamHubArtifactDownloadOptions;
  retryAccepted?: boolean;
  url: URL;
  verifyResponseSha256?: boolean;
}) {
  return runBoundedArtifactDownload(options, async (signal) => {
    let response: Response;
    while (true) {
      response = await fetchRequest(url, {
        credentials: "include",
        method: "GET",
        signal,
      });
      if (!retryAccepted || response.status !== 202) break;
      await response.body?.cancel();
      await waitForArtifactRetry(response.headers.get("retry-after"), signal);
    }

    if (!response.ok) {
      const error = await readTeamHubError(response);
      if (response.status === 401) {
        onAuthenticationRequired("session-expired");
      }
      throw error;
    }

    const content = await readBoundedArtifactContent(response, {
      expectedSizeBytes: options?.expectedSizeBytes,
      signal,
    });
    // ETags are cache validators and may be removed by compression proxies.
    // Prefer the source-byte digest; retain ETag compatibility for older servers.
    const sourceDigest = response.headers.get("x-content-sha256");
    const digestMatches =
      sourceDigest !== null
        ? sourceDigest === content.sha256
        : response.headers.get("etag")?.replace(/^W\//, "") ===
          `"${content.sha256}"`;
    if (verifyResponseSha256 && !digestMatches) {
      throw new Error("The File download failed integrity verification.");
    }
    return content;
  });
}

async function waitForArtifactRetry(value: string | null, signal: AbortSignal) {
  const seconds = Number(value ?? "1");
  const delay = Number.isFinite(seconds)
    ? Math.min(2_000, Math.max(100, seconds * 1_000))
    : 1_000;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function downloadTeamHubArtifactRange({
  fetchRequest,
  onAuthenticationRequired,
  options,
  url,
}: {
  fetchRequest: typeof fetch;
  onAuthenticationRequired: (reason: TeamHubAuthenticationReason) => void;
  options: TeamHubArtifactRangeOptions;
  url: URL;
}) {
  const start = options.start ?? 0;
  validateArtifactRangeOptions(options, start);
  const expectedLength = options.endInclusive - start + 1;

  return runBoundedArtifactDownload(options, async (signal) => {
    const expectedEtag = `"${options.expectedSha256}"`;
    const response = await fetchRequest(url, {
      credentials: "include",
      headers: {
        "If-Range": expectedEtag,
        Range: `bytes=${start}-${options.endInclusive}`,
      },
      method: "GET",
      signal,
    });

    if (!response.ok) {
      const error = await readTeamHubError(response);
      if (response.status === 401) {
        onAuthenticationRequired("session-expired");
      }
      throw error;
    }
    if (response.status !== 206) {
      throw new Error("The File preview server did not honor the byte range.");
    }
    if (response.headers.get("etag") !== expectedEtag) {
      throw new Error(
        "The File preview no longer matches its immutable Version.",
      );
    }

    const range = parseContentRange(response.headers.get("content-range"));
    if (
      range.start !== start ||
      range.endInclusive !== options.endInclusive ||
      range.totalSize !== options.expectedTotalSize
    ) {
      throw new Error("The File preview returned an unexpected byte range.");
    }
    const content = await readBoundedArtifactContent(response, {
      expectedSizeBytes: expectedLength,
      signal,
    });
    return {
      blob: content.blob,
      endInclusive: range.endInclusive,
      mediaType: content.mediaType,
      start: range.start,
      totalSize: range.totalSize,
    } satisfies TeamHubArtifactRangeContent;
  });
}

export async function runBoundedArtifactDownload<T>(
  options: TeamHubArtifactDownloadOptions | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  validateExpectedSize(options?.expectedSizeBytes);
  const timeoutMs = options?.timeoutMs ?? defaultDownloadTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("File download timeout must be a positive duration.");
  }

  let timedOut = false;
  const abortFromCaller = () =>
    controller.abort(
      options?.signal?.reason ??
        new DOMException("File download was cancelled.", "AbortError"),
    );
  if (options?.signal?.aborted) {
    abortFromCaller();
  } else {
    options?.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException("File download timed out.", "TimeoutError"),
    );
  }, timeoutMs);

  try {
    throwIfAborted(controller.signal);
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error("File download timed out.", { cause: error });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function readBoundedArtifactContent(
  response: Response,
  {
    expectedSizeBytes,
    signal,
  }: Pick<TeamHubArtifactDownloadOptions, "expectedSizeBytes"> & {
    signal: AbortSignal;
  },
): Promise<TeamHubArtifactContent> {
  try {
    validateExpectedSize(expectedSizeBytes);
    // Fetch decodes compressed bodies, but Content-Length still describes the
    // encoded transfer. The streaming checks below verify the decoded size.
    const encoding = response.headers
      .get("content-encoding")
      ?.trim()
      .toLowerCase();
    validateContentLength(
      response.headers.get("content-length"),
      !encoding || encoding === "identity" ? expectedSizeBytes : undefined,
    );
    throwIfAborted(signal);
  } catch (error) {
    await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(
      "The browser did not expose a bounded File download stream.",
    );
  }

  const chunks: BlobPart[] = [];
  const digest = sha256.create();
  let receivedBytes = 0;
  const cancelReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAXIMUM_ARTIFACT_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error("The File download exceeded the 100 MiB client limit.");
      }
      if (
        expectedSizeBytes !== undefined &&
        receivedBytes > expectedSizeBytes
      ) {
        await reader.cancel();
        throwVersionSizeMismatch();
      }

      digest.update(chunk.value);
      chunks.push(chunk.value);
    }
    throwIfAborted(signal);
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }

  if (expectedSizeBytes !== undefined && receivedBytes !== expectedSizeBytes) {
    throwVersionSizeMismatch();
  }

  const mediaType =
    response.headers.get("content-type") ?? "application/octet-stream";
  return {
    blob: new Blob(chunks, { type: mediaType }),
    mediaType,
    sha256: bytesToHex(digest.digest()),
  };
}

function validateExpectedSize(expectedSizeBytes: number | undefined) {
  if (expectedSizeBytes === undefined) {
    return;
  }
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
    throw new Error("The immutable Version has no usable byte size.");
  }
  if (expectedSizeBytes > MAXIMUM_ARTIFACT_DOWNLOAD_BYTES) {
    throw new Error("The File download exceeded the 100 MiB client limit.");
  }
}

function validateArtifactRangeOptions(
  options: TeamHubArtifactRangeOptions,
  start: number,
) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(options.endInclusive) ||
    !Number.isSafeInteger(options.expectedTotalSize) ||
    start < 0 ||
    options.endInclusive < start ||
    options.expectedTotalSize <= options.endInclusive ||
    !/^[a-f0-9]{64}$/i.test(options.expectedSha256)
  ) {
    throw new Error("The immutable Version has no usable byte range metadata.");
  }
  if (options.endInclusive - start + 1 > MAXIMUM_ARTIFACT_DOWNLOAD_BYTES) {
    throw new Error("The File download exceeded the 100 MiB client limit.");
  }
}

function parseContentRange(header: string | null) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? "");
  if (!match) {
    throw new Error("The File preview returned an invalid Content-Range.");
  }
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const totalSize = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    !Number.isSafeInteger(totalSize) ||
    start < 0 ||
    endInclusive < start ||
    totalSize <= endInclusive
  ) {
    throw new Error("The File preview returned an invalid Content-Range.");
  }
  return { endInclusive, start, totalSize };
}

function validateContentLength(
  header: string | null,
  expectedSizeBytes: number | undefined,
) {
  if (header === null) {
    return;
  }
  if (!/^\d+$/.test(header.trim())) {
    throw new Error("The File download returned an invalid Content-Length.");
  }

  const contentLength = Number(header);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength > MAXIMUM_ARTIFACT_DOWNLOAD_BYTES
  ) {
    throw new Error("The File download exceeded the 100 MiB client limit.");
  }
  if (expectedSizeBytes !== undefined && contentLength !== expectedSizeBytes) {
    throwVersionSizeMismatch();
  }
}

function throwVersionSizeMismatch(): never {
  throw new Error(
    "The downloaded bytes do not match its immutable Version metadata.",
  );
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw (
      signal.reason ??
      new DOMException("File download was cancelled.", "AbortError")
    );
  }
}
