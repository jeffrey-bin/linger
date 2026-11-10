import { fileURLToPath } from "node:url";
import path from "node:path";

type Fetcher = typeof fetch;

export interface WaitForHttpServicesOptions {
  fetcher?: Fetcher;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

export async function waitForHttpServices(
  urls: readonly string[],
  options: WaitForHttpServicesOptions = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? delay;
  const requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  const pending = new Set(urls.map(validateHttpUrl));

  while (pending.size > 0 && Date.now() < deadline) {
    for (const url of pending) {
      try {
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (response.ok) pending.delete(url);
      } catch {
        // The local service is still starting.
      }
    }
    if (pending.size > 0) await sleep(500);
  }

  if (pending.size > 0) {
    throw new Error(
      `Timed out waiting for local services: ${[...pending].join(", ")}`,
    );
  }
}

function validateHttpUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(`Local service URL must be an HTTP(S) URL: ${value}`);
  }
  return url.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function main(urls: string[]): Promise<void> {
  if (urls.length === 0) {
    throw new Error("Usage: wait-for-http-services <URL> [URL ...]");
  }
  await waitForHttpServices(urls);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
