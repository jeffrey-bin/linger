import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

export interface ArtifactReadingPosition {
  pageNumber?: number;
  scale?: number;
  scrollTop?: number;
  scrollLeft?: number;
  officeScroll?: { top: number; left: number };
}

export interface CachedArtifactContent {
  blob: Blob;
  mediaType: string;
  textContent?: string;
  readingPosition: ArtifactReadingPosition;
}

interface Transfer {
  controller: AbortController;
  promise: Promise<CachedArtifactContent>;
  readers: number;
}

// A tab-local budget for retained bytes and decoded strings, not active renderers.
// Entries contain no authorization decisions, object URLs or preview sessions.
export class ArtifactPreviewCache {
  private readonly entries = new Map<string, CachedArtifactContent>();
  private readonly transfers = new Map<string, Transfer>();
  private clients = new WeakMap<TeamHubClient, number>();
  private nextClientId = 0;
  private bytes = 0;
  revision = 0;

  constructor(
    private readonly maxBytes = 128 * 1024 * 1024,
    private readonly maxEntries = 24,
  ) {}

  // Keys separate client instances only. Access is never inferred from a key:
  // every displayed preview first passes a fresh server read check.
  scope(client: TeamHubClient) {
    let id = this.clients.get(client);
    if (id === undefined) {
      id = ++this.nextClientId;
      this.clients.set(client, id);
    }
    return id;
  }

  clear() {
    this.revision++;
    this.entries.clear();
    this.bytes = 0;
    for (const transfer of this.transfers.values()) transfer.controller.abort();
    this.transfers.clear();
  }

  async get(
    key: string,
    signal: AbortSignal,
    load: (signal: AbortSignal) => Promise<CachedArtifactContent>,
  ) {
    signal.throwIfAborted();
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    let transfer = this.transfers.get(key);
    if (!transfer) {
      const controller = new AbortController();
      transfer = {
        controller,
        readers: 0,
        promise: Promise.resolve().then(() => load(controller.signal)),
      };
      const current = transfer;
      current.promise = current.promise
        .then((content) => {
          controller.signal.throwIfAborted();
          if (this.transfers.get(key) === current) this.retain(key, content);
          return content;
        })
        .finally(() => {
          if (this.transfers.get(key) === current) this.transfers.delete(key);
        });
      this.transfers.set(key, current);
    }
    const current = transfer;
    current.readers++;
    return new Promise<CachedArtifactContent>((resolve, reject) => {
      let settled = false;
      const release = () => {
        settled = true;
        signal.removeEventListener("abort", abort);
        current.controller.signal.removeEventListener("abort", abort);
        current.readers--;
        if (current.readers === 0 && this.transfers.get(key) === current) {
          this.transfers.delete(key);
          current.controller.abort();
        }
      };
      const abort = () => {
        if (settled) return;
        release();
        reject(
          new DOMException("Preview loading was cancelled.", "AbortError"),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      current.controller.signal.addEventListener("abort", abort, {
        once: true,
      });
      current.promise.then(
        (content) => {
          if (settled) return;
          release();
          resolve(content);
        },
        (error) => {
          if (settled) return;
          release();
          reject(error);
        },
      );
    });
  }

  private retain(key: string, content: CachedArtifactContent) {
    const size = retainedSize(content);
    if (size > this.maxBytes) return;
    this.entries.set(key, content);
    this.bytes += size;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes -= retainedSize(oldest[1]);
    }
  }
}

function retainedSize(content: CachedArtifactContent) {
  return content.blob.size + (content.textContent?.length ?? 0) * 2;
}

export const artifactPreviewCache = new ArtifactPreviewCache();
