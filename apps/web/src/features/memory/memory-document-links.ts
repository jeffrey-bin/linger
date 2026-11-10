/**
 * Daily reports and meeting summaries cite private Memory files and internal
 * evidence URIs that have no reader route, so those render as plain text
 * (`null`); anchors, external URLs, and Product Client routes stay as written
 * (`undefined`).
 */
export function resolveMemoryDocumentLink(reference: string): null | undefined {
  const value = reference.trim();
  if (/^(?:teamhub|memory):/i.test(value)) return null;
  if (!value || /^(?:#|\/\/|[a-z][a-z\d+.-]*:)/i.test(value)) return undefined;
  if (value.startsWith("/t/")) return undefined;
  return null;
}
