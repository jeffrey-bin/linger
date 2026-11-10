import { expect, it, vi } from "vitest";

import { WorkerDocumentNormalizer } from "../../src/document-normalizer/document-normalizer.js";
import { pdfFixture } from "./fixtures/document-normalizer-fixtures.js";

it("waits for the conversion result when Node watch reports worker dependencies", async () => {
  vi.stubEnv("WATCH_REPORT_DEPENDENCIES", "1");
  try {
    const markdown = await new WorkerDocumentNormalizer().normalizeDocument({
      filename: "probe.pdf",
      mediaType: "application/pdf",
      source: pdfFixture("Watch mode probe"),
    });
    expect(new TextDecoder().decode(markdown)).toBe("Watch mode probe\n");
  } finally {
    vi.unstubAllEnvs();
  }
});
