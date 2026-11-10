import { describe, expect, it } from "vitest";

import { repairEscapedNewlinePdf } from "./pdf-preview-bytes";

describe("repairEscapedNewlinePdf", () => {
  it("turns literal \\n sequences into real newlines for escaped dummy PDFs", () => {
    const escaped = "%PDF-1.4\\n1 0 obj\\n%%EOF\\n";
    const repaired = new TextDecoder().decode(
      new Uint8Array(
        repairEscapedNewlinePdf(new TextEncoder().encode(escaped).buffer),
      ),
    );

    expect(repaired).toBe("%PDF-1.4\n1 0 obj\n%%EOF\n");
  });

  it("leaves ordinary PDFs unchanged", () => {
    const ordinary = "%PDF-1.4\n1 0 obj\n%%EOF\n";
    const bytes = new TextEncoder().encode(ordinary);
    expect(repairEscapedNewlinePdf(bytes.buffer)).toBe(bytes.buffer);
  });
});
