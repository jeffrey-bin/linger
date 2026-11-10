import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renameRetrying } from "./fs-retry.js";

export interface DownloadTiming {
  /**
   * Rounds over the hosts; each round tries every host once, and an
   * interrupted attempt resumes where the last one stopped.
   */
  attempts: number;
  /** Wait before the second round; it doubles for each later one. */
  retryDelayMs: number;
  /** An attempt that receives no bytes for this long starts again. */
  idleTimeoutMs: number;
}
const defaultTiming: DownloadTiming = {
  attempts: 4,
  retryDelayMs: 2_000,
  idleTimeoutMs: 60_000,
};

function publicUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Download requires a public HTTPS URL without credentials or query parameters.",
    );
  return url;
}

/**
 * Only a verified, bounded download may become an installation input. A
 * failed, slow or interrupted transfer moves on to the next mirror and
 * resumes there with an HTTP range request; the checksum still decides what
 * is published.
 */
export async function downloadVerified(
  options: {
    url: string;
    /** Other hosts serving the same bytes, tried after `url`. */
    mirrors?: readonly string[];
    output: string;
    algorithm: "sha256" | "sha512";
    digest: string;
    maxBytes: number;
    signal: AbortSignal;
    onProgress?: (completed: number, total?: number) => void;
    /** Keep `<output>.part` after a failure so the next call resumes it. */
    resumable?: boolean;
  },
  fetcher: typeof fetch = fetch,
  timing: DownloadTiming = defaultTiming,
) {
  const urls = [options.url, ...(options.mirrors ?? [])].map(publicUrl);
  const digestLength = options.algorithm === "sha256" ? 64 : 128;
  if (!new RegExp(`^[a-f0-9]{${digestLength}}$`).test(options.digest))
    throw new Error("Invalid trusted checksum.");
  options.signal.throwIfAborted();
  const name = path.posix.basename(urls[0]!.pathname) || urls[0]!.host;
  const hosts = [...new Set(urls.map((url) => url.host))].join(" and ");
  const partial = options.resumable
    ? `${options.output}.part`
    : `${options.output}.${randomUUID()}.part`;
  let hash: Hash = createHash(options.algorithm);
  let completed = 0;
  if (options.resumable) {
    const existing = await lstat(partial).catch(() => undefined);
    if (existing?.isFile() && existing.size <= options.maxBytes) {
      for await (const chunk of createReadStream(partial))
        hash.update(chunk as Buffer);
      completed = existing.size;
    } else await rm(partial, { recursive: true, force: true });
  }
  const handle = await open(partial, options.resumable ? "a" : "ax", 0o600);
  let size: number | undefined;
  let lastProgressAt = 0;
  let failure = "no connection";

  // One request: "done" when the body ended, "retry" after a transient
  // failure, "next" when this host cannot serve the file.
  const attempt = async (url: URL): Promise<"done" | "retry" | "next"> => {
    const stalled = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const watch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => stalled.abort(), timing.idleTimeoutMs);
    };
    watch();
    try {
      let response: Response;
      try {
        response = await fetcher(url, {
          redirect: "error",
          signal: AbortSignal.any([options.signal, stalled.signal]),
          ...(completed ? { headers: { range: `bytes=${completed}-` } } : {}),
        });
      } catch {
        options.signal.throwIfAborted();
        failure = stalled.signal.aborted ? "no response" : "no connection";
        return "retry";
      }
      if (
        completed &&
        response.status === 206 &&
        !(response.headers.get("content-range") ?? "").startsWith(
          `bytes ${completed}-`,
        )
      ) {
        await response.body?.cancel();
        failure = "invalid range response";
        return "next";
      }
      // The previous call received every byte; the checksum decides.
      if (completed && response.status === 416) {
        await response.body?.cancel();
        return "done";
      }
      if (completed && response.status === 200) {
        // The host ignored the range, so this response starts over.
        await handle.truncate(0);
        hash = createHash(options.algorithm);
        completed = 0;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        failure = `HTTP ${response.status}`;
        // A missing or forbidden file stays so on this host.
        return response.status >= 400 &&
          response.status < 500 &&
          ![408, 429].includes(response.status)
          ? "next"
          : "retry";
      }
      const length = Number(response.headers.get("content-length")) || 0;
      size = length ? completed + length : undefined;
      if (size && size > options.maxBytes) {
        await response.body.cancel();
        throw new Error("Download size exceeds limit.");
      }
      const reader = response.body.getReader();
      // Some bodies ignore the abort signal, so a stall also ends the read.
      const stall = new Promise<never>((_resolve, reject) =>
        stalled.signal.addEventListener("abort", () => reject(new Error())),
      );
      stall.catch(() => {});
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await Promise.race([reader.read(), stall]);
          } catch {
            options.signal.throwIfAborted();
            failure = stalled.signal.aborted ? "stalled" : "interrupted";
            return "retry";
          }
          const { done, value } = chunk;
          if (done) return "done";
          watch();
          completed += value.byteLength;
          if (completed > options.maxBytes)
            throw new Error("Download size exceeds limit.");
          hash.update(value);
          await handle.writeFile(value);
          if (Date.now() - lastProgressAt >= 250) {
            options.onProgress?.(completed, size);
            lastProgressAt = Date.now();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(idle);
    }
  };

  let published = false;
  try {
    let result: "done" | "retry" | "next" = "next";
    // Hosts that cannot serve the file leave the rotation.
    let active = urls;
    rounds: for (let round = 0; round < timing.attempts; round += 1) {
      if (!active.length) break;
      if (round > 0)
        await delay(timing.retryDelayMs * 2 ** (round - 1), undefined, {
          signal: options.signal,
        });
      for (const url of active) {
        result = await attempt(url);
        if (result === "done") break rounds;
        if (result === "next") active = active.filter((item) => item !== url);
      }
    }
    if (result !== "done")
      throw new Error(
        `Download of ${name} from ${hosts} failed (${failure}). Check your network and retry.`,
      );
    if (hash.digest("hex") !== options.digest) {
      completed = 0;
      throw new Error("Download checksum mismatch.");
    }
    options.onProgress?.(completed, size);
    await handle.sync();
    options.signal.throwIfAborted();
    await handle.close();
    await renameRetrying(partial, options.output, {
      signal: options.signal,
    });
    published = true;
  } finally {
    await handle.close().catch(() => {});
    // A resumable download keeps what it received for the next call.
    if (!published && (!options.resumable || completed === 0))
      await rm(partial, { force: true });
  }
}
