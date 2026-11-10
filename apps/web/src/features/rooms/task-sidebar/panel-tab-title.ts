export function panelTabTitle(body: string) {
  const normalized = body.trim().replace(/\s+/g, " ");
  return normalized.length > 24
    ? `${normalized.slice(0, 24).trimEnd()}…`
    : normalized || "Untitled";
}
