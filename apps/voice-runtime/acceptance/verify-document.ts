import { createHash } from "node:crypto";

export interface AcceptanceDocument {
  id: string;
  format: string;
  representation_format: string;
  capabilities: { read: boolean };
  current_version?: { id: string } | null;
}

export async function readNativeDocument(
  document: AcceptanceDocument,
  get: (path: string) => Promise<Response>,
): Promise<string> {
  if (
    !document.capabilities.read ||
    document.format !== "blocknote" ||
    document.representation_format !== "markdown"
  ) {
    throw new Error("Capture native Document is not readable Markdown");
  }
  const deadline = Date.now() + 120_000;
  while (true) {
    const response = await get(
      `/v0/documents/${encodeURIComponent(document.id)}/downloads`,
    );
    if (response.status === 202) {
      await response.body?.cancel();
      if (Date.now() >= deadline)
        throw new Error("Capture native Document projection is not ready");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    if (response.status !== 200)
      throw new Error("Capture native Document download failed");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.length === 0 ||
      createHash("sha256").update(bytes).digest("hex") !==
        response.headers.get("x-content-sha256")
    ) {
      throw new Error("Capture native Document content digest mismatch");
    }
    return new TextDecoder().decode(bytes);
  }
}

export async function verifyCaptureDocumentHead(
  document: AcceptanceDocument,
  version: { id: string; document_id: string },
  originalMarkdown: string | undefined,
  get: (path: string) => Promise<Response>,
): Promise<void> {
  if (document.id !== version.document_id || !document.capabilities.read) {
    throw new Error("Capture Document card is not readable");
  }
  if (document.current_version?.id === version.id) return;
  if (document.current_version || originalMarkdown === undefined) {
    throw new Error("Capture Document card resolves to another output Version");
  }
  const current = await readNativeDocument(document, get);
  const normalize = (text: string) =>
    text
      .normalize("NFKC")
      .replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, "$1")
      .replace(/\s+/g, "");
  if (normalize(current) !== normalize(originalMarkdown)) {
    throw new Error(
      "Capture editable transcript differs from its original output",
    );
  }
}
