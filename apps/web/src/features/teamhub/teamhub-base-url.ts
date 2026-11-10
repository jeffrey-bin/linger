// resolveTeamHubBaseUrl returns the configured TeamHub API base, or the page
// origin when none is configured, as a directory URL for relative paths.
export function resolveTeamHubBaseUrl(configured?: string) {
  if (configured?.trim()) {
    return new URL(configured.endsWith("/") ? configured : `${configured}/`);
  }
  return new URL("/", globalThis.location?.origin ?? "http://localhost");
}
