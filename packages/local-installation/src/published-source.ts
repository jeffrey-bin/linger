import { readFile } from "node:fs/promises";

/** Publisher-owned metadata travels with the small CLI kit, never with user input. */
export async function readPublishedSource(
  file: string,
): Promise<PublishedServiceSource | undefined> {
  let value: {
    platform?: unknown;
    arch?: unknown;
    serviceRelease?: { url?: unknown; sha256?: unknown; bytes?: unknown };
  };
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      "The Linger distribution metadata is invalid. Download the installer again.",
      { cause: error },
    );
  }
  if (
    !value ||
    value.platform !== process.platform ||
    value.arch !== process.arch
  )
    throw new Error(
      "The Linger distribution target does not match this computer.",
    );
  if (value.serviceRelease === undefined) return;
  return validatePublishedServiceSource(value.serviceRelease);
}
export interface PublishedServiceSource {
  url: string;
  /** Other hosts serving the same bytes, tried in order after `url`. */
  mirrors?: string[];
  sha256: string;
  bytes: number;
  delivery?: "ghcr";
  /** Cold-cache, deduplicated compressed layer bytes, excluding HTTP overhead. */
  imageDownloadBytes?: number;
}
export function validatePublishedServiceSource(
  input: unknown,
): PublishedServiceSource {
  const source = input as {
    url?: unknown;
    mirrors?: unknown;
    sha256?: unknown;
    bytes?: unknown;
    delivery?: unknown;
    imageDownloadBytes?: unknown;
  };
  if (
    !source ||
    typeof source.url !== "string" ||
    typeof source.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(source.sha256) ||
    typeof source.bytes !== "number" ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes <= 0 ||
    source.bytes > 5 * 1024 ** 3
  )
    throw new Error("The published service source is incomplete.");
  if (
    source.mirrors !== undefined &&
    (!Array.isArray(source.mirrors) ||
      source.mirrors.length > 4 ||
      source.mirrors.some((mirror) => typeof mirror !== "string"))
  )
    throw new Error("The published service mirrors are invalid.");
  const mirrors = (source.mirrors ?? []) as string[];
  for (const value of [source.url, ...mirrors]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("The published service URL is invalid.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "The published service source requires a credential-free HTTPS URL.",
      );
  }
  if (
    (source.delivery !== undefined && source.delivery !== "ghcr") ||
    (source.imageDownloadBytes !== undefined &&
      (source.delivery !== "ghcr" ||
        typeof source.imageDownloadBytes !== "number" ||
        !Number.isSafeInteger(source.imageDownloadBytes) ||
        source.imageDownloadBytes < 0 ||
        source.imageDownloadBytes > 50 * 1024 ** 3))
  )
    throw new Error("Invalid GHCR image download budget.");
  return {
    url: source.url,
    ...(mirrors.length ? { mirrors } : {}),
    sha256: source.sha256,
    bytes: source.bytes,
    ...(source.delivery === "ghcr"
      ? {
          delivery: "ghcr" as const,
          ...(typeof source.imageDownloadBytes === "number"
            ? { imageDownloadBytes: source.imageDownloadBytes }
            : {}),
        }
      : {}),
  };
}
