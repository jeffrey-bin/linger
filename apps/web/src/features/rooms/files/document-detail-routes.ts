export function documentDetailPath(input: {
  documentId: string;
  tenantId: string;
}) {
  return `/t/${encodeURIComponent(input.tenantId)}/documents/${encodeURIComponent(input.documentId)}`;
}

export interface InternalRoomDocumentLink {
  documentId: string;
  tenantId: string;
}

export function parseInternalRoomDocumentLink(
  value: string,
  expectedOrigin: string,
): InternalRoomDocumentLink | null {
  let url: URL;
  try {
    url = new URL(value.trim(), expectedOrigin);
  } catch {
    return null;
  }
  if (url.origin !== expectedOrigin || url.search || url.hash) return null;

  const match = url.pathname.match(/^\/t\/([^/]+)\/documents\/([^/]+)\/?$/);
  if (!match) return null;

  try {
    return {
      documentId: decodeURIComponent(match[2]!),
      tenantId: decodeURIComponent(match[1]!),
    };
  } catch {
    return null;
  }
}
