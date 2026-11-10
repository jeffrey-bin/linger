import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyCaptureDocumentHead } from "../acceptance/verify-document.js";

const version = { id: "source", document_id: "transcript" };
const native = {
  id: "transcript",
  format: "blocknote",
  representation_format: "markdown",
  capabilities: { read: true },
};
const response = (text: string) =>
  new Response(text, {
    headers: {
      "x-content-sha256": createHash("sha256").update(text).digest("hex"),
    },
  });

describe("Capture Document delivery", () => {
  it("accepts the immutable Version without requesting a native projection", async () => {
    const get = vi.fn();
    await verifyCaptureDocumentHead(
      { ...native, format: "file", current_version: { id: "source" } },
      version,
      undefined,
      get,
    );
    expect(get).not.toHaveBeenCalled();
  });
  it("reads and verifies the full editable transcript, including escaped time ranges", async () => {
    const get = vi.fn(async () =>
      response("# Transcript\n\n\\[00:01\\] A complete long sentence\n"),
    );
    await verifyCaptureDocumentHead(
      native,
      version,
      "# Transcript\n[00:01] A complete long sentence",
      get,
    );
    expect(get).toHaveBeenCalledWith("/v0/documents/transcript/downloads");
  });
  it("rejects a readable but truncated native transcript", async () => {
    await expect(
      verifyCaptureDocumentHead(
        native,
        version,
        "A complete long sentence",
        async () => response("A complete"),
      ),
    ).rejects.toThrow("differs");
  });
  it("rejects mismatched download integrity and a different current Version", async () => {
    await expect(
      verifyCaptureDocumentHead(
        native,
        version,
        "A complete",
        async () => new Response("A complete"),
      ),
    ).rejects.toThrow("digest");
    await expect(
      verifyCaptureDocumentHead(
        { ...native, current_version: { id: "other" } },
        version,
        "A complete",
        vi.fn(),
      ),
    ).rejects.toThrow("another output Version");
  });
});
