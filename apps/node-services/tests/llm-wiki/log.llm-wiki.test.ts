import { describe, expect, it, vi } from "vitest";

import { writeWikiLog } from "../../src/llm-wiki/log.js";

describe("Wiki structured logs", () => {
  it("writes refresh failures with ERROR level", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      writeWikiLog(
        "llm_wiki_refresh_failed",
        {
          wiki_refresh_id: "wiki_refresh_1",
          code: "WIKI_REFRESH_GENERATION_INVALID",
        },
        "ERROR",
      );
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
        event: "llm_wiki_refresh_failed",
        level: "error",
        service: "node-services",
        role: "llm-wiki",
        wiki_refresh_id: "wiki_refresh_1",
        code: "WIKI_REFRESH_GENERATION_INVALID",
      });
    } finally {
      write.mockRestore();
    }
  });
});
