export const NODE_RUNTIME_VERSION: string;
export const NODE_RUNTIME_RELEASES: Readonly<
  Record<string, { readonly archive: string; readonly sha256: string }>
>;
export const RELEASE_TARGETS: readonly string[];
export const NODE_RUNTIME_DOWNLOAD_BASE_URL: string;
export const NODE_RUNTIME_DOWNLOAD_MIRRORS: readonly string[];
export function nodeRuntimeDownloadUrls(
  archive: string,
  version?: string,
  baseUrls?: readonly string[],
): string[];
