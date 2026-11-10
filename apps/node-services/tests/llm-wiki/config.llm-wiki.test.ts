import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLlmWikiConfig } from "../../src/llm-wiki/config.js";
import { serviceCredential } from "@linger/service-kit/node";
import { mirrorHome } from "../../src/paths.js";

describe("loadLlmWikiConfig", () => {
  it("keeps its data under the Agent state directory", () => {
    expect(loadLlmWikiConfig({}).dataDirectory).toBe(
      join(mirrorHome({}), "llm-wiki"),
    );
  });

  it("reads its data directory and the TeamHub service token", () => {
    const environment = {
      LINGER_SECRET_SEED: "test-seed-0123456789abcdef0123456789",
    };
    expect(loadLlmWikiConfig(environment)).toEqual({
      dataDirectory: join(mirrorHome(environment), "llm-wiki"),
      teamHubServiceToken: serviceCredential(
        "node-services-internal",
        environment,
      ),
    });
  });
});
