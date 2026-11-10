import { describe, expect, it } from "vitest";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import { useDocumentComputation } from "./computation-test-support.js";

const teamHubToken = "teamhub-to-runtime-responsiveness-token";
const operationId = "4f0c3c4e-9d7a-4d3e-9a51-6f2b8c1d0e77";
const sectionCount = 1_740;
// CI runners are slower and share CPU with other test files; the assertion
// is about event-loop gaps, not total duration.
const testTimeoutMs = 60_000;

describe("Document Runtime computation responsiveness", () => {
  const computation = useDocumentComputation();

  it(
    "keeps health probes and the event loop responsive during a CPU-heavy Markdown import",
    async () => {
      const app = createDocumentRuntimeApp({ teamHubToken, computation });
      const body = {
        operation_id: operationId,
        schema_version: 1,
        source_kind: "markdown",
        source_bytes: Buffer.from(largeMarkdown()).toString("base64"),
      };
      let maxGapMs = 0;
      let lastTick = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - lastTick);
        lastTick = now;
      }, 10);
      const healthStatuses: number[] = [];
      let finished = false;
      const materialized = (async () => {
        try {
          return await app.request("/internal/v1/documents/import", {
            method: "POST",
            headers: {
              authorization: `Bearer ${teamHubToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
        } finally {
          finished = true;
        }
      })();
      try {
        while (!finished) {
          healthStatuses.push((await app.request("/healthz")).status);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        clearInterval(timer);
      }

      const response = await materialized;
      expect(response.status).toBe(200);
      expect(healthStatuses.length).toBeGreaterThan(0);
      expect(healthStatuses.every((status) => status === 200)).toBe(true);
      expect(maxGapMs).toBeLessThan(250);
    },
    testTimeoutMs,
  );
});

function largeMarkdown(): string {
  return Array.from(
    { length: sectionCount },
    (_, section) =>
      `## Section ${section}\n\nParagraph ${section} with **bold** text, a [link](https://example.com/${section}) and filler words so the body resembles a real page.\n\n- first item ${section}\n- second item ${section}\n`,
  ).join("\n");
}
